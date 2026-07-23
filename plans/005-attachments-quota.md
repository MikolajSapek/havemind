# Havemind — plan: limit magazynu (quota) załączników per-vault

- Status: **Szkic do zatwierdzenia**
- Data: 2026-07-24
- Realizuje: `specs/003-open-source-release.md` (bramka „Stage 3 — general beta": „Attachment synchronization, quotas and retention behavior are implemented"), rozszerza `plans/001-technical-plan.md` §8 („enforces explicit limits for bodies, batches, parent counts, note size and vault quota") oraz §11 Faza 8 (c) „attachments/quota".
- Zależności: załączniki binarne są już zaimplementowane end-to-end (F9). Ten plan dokłada WYŁĄCZNIE limit sumarycznego magazynu, nie zmienia formatu payloadu ani granicy opaque serwera.

## Kontekst — co już istnieje (nie przeplanowywać)

Zaimplementowane i działające:

- `DEFAULT_MAX_PAYLOAD_BYTES = 36 * 1024 * 1024` (36 MiB) w `apps/server/src/sync/sync-routes.ts` — górna granica pojedynczego payloadu rewizji po dekodowaniu base64.
- `DEFAULT_BODY_LIMIT_BYTES = 40 * 1024 * 1024` (40 MiB) w `apps/server/src/config.ts`; `MAX_BODY_LIMIT_BYTES = 64 * 1024 * 1024`, `MIN_BODY_LIMIT_BYTES = 1024`.
- `DEFAULT_MAX_BATCH_SIZE = 64` rewizji na żądanie push.
- Allowlist wtyczki: `png`/`jpg`/`pdf` do 25 MB surowego pliku (≈33,4 MB po base64, stąd 36 MiB payload).
- Blob store content-addressed (`apps/server/src/blob-store.ts`): `put` liczy SHA-256, publikuje atomowo (temp → `fsync` → `rename` → `fsync` katalogu), deduplikuje po hashu globalnie.
- Kolumna `revisions.blob_size INTEGER NOT NULL CHECK (blob_size >= 0)` oraz indeks `revisions_by_blob_hash` (`apps/server/src/migrations/001-initial.sql`).
- `sweepOrphanedBlobs` (`apps/server/src/blob-gc.ts`) — zamiata osierocone bloby WYŁĄCZNIE na starcie serwera, gdy żaden push nie commituje równolegle.
- Ścieżka push: `blobStore.put(payload)` **przed** `commitRevision(...)` w jednej pętli po batchu; odrzucona rewizja zostawia blob na dysku do startowego sweepu.

Czego **BRAK** i co ten plan projektuje:

1. Sumaryczny limit bajtów magazynu per-vault (quota) — total cap na vault.
2. Egzekwowanie per-plik i per-vault na ścieżce push.
3. Nowy, stabilny kod błędu opaque serwera dla przekroczenia quoty + UX klienta.
4. Interakcja quoty z append-only historią + `blob-gc` (stare rewizje zachowują bloby — rozliczanie musi to uwzględniać).
5. Ochrona przed presją dyskową na `sapserver` (jeden ITX box, reguła 7 z `plan/01-zasady-i-slownik.md`: 16 GB RAM, ~96 GB wolnego dysku).
6. Sposób dla ownera/admina na podejrzenie i ustawienie quoty.

## Spec

### S1. Model rozliczania (uwzględnia append-only + dedup)

Serwer pozostaje opaque: nigdy nie liczy diffa/provenance/merge (reguła 3). Quota to czysto bajtowe rozliczanie po `blob_size`, które serwer i tak już zna z receiptu — nie wymaga zaglądania w treść payloadu.

Definicja **`vault_storage_bytes`** dla vaultu `V`:

```
vault_storage_bytes(V) = SUM(blob_size) po ZBIORZE RÓŻNYCH blob_hash
                         referowanych przez dowolną rewizję w V
```

Uzasadnienie doboru definicji:

- **Append-only historia liczy się w całości.** Każdy `blob_hash`, do którego kiedykolwiek istniała rewizja w `V` — także rewizja już nie będąca headem — jest wliczony, dopóki `blob-gc` go nie usunie. To celowe: pilot i pierwszy realny vault przechowują pełną historię (`plans/001` §7 „bootstraps a new device from complete retained history"), więc quota MUSI odzwierciedlać realny koszt dysku historii, a nie tylko bieżących headów. Nie wolno projektować quoty na headach — dałoby to klientowi złudzenie, że nadpisanie dużego pliku zwalnia miejsce, gdy fizycznie nie zwalnia.
- **DISTINCT blob_hash, nie SUM po wszystkich rewizjach.** Dwie rewizje o identycznej treści (ten sam `blob_hash`) dzielą jeden plik blobu (content-addressed store), więc liczą się raz. To zgodne z fizycznym zajęciem dysku w obrębie vaultu i nie karze klienta za idempotentny retry (ten sam `revision_id` + te same bajty).
- **Rozliczanie jest per-vault, mimo że blob store jest globalny.** Ten sam blob współdzielony między dwoma vaultami liczy się do quoty każdego z nich (over-count względem fizycznego dysku). To akceptowalna, bezpieczna strona błędu: quota to budżet logiczny vaultu, nie księgowość fizycznego dysku. Fizyczny dysk chroni osobny mechanizm S6 (free-disk guard).

Zapytanie rozliczające (parametryzowane, wykorzystuje `revisions_by_blob_hash`):

```sql
SELECT COALESCE(SUM(blob_size), 0) AS used
FROM (
  SELECT DISTINCT blob_hash, blob_size
  FROM revisions
  WHERE vault_id = ?
);
```

Dla wydajności (unikanie skanu przy każdym push na dużym vaulcie) utrzymywana jest **materializowana suma** — patrz S3 (kolumna `vaults.storage_bytes`), a powyższe zapytanie jest kanonicznym źródłem prawdy do walidacji/odtworzenia licznika (rebuild po restore, test spójności).

### S2. Limity i ich domyślne wartości

- **`vault_quota_bytes`** — sumaryczny limit magazynu per-vault. Domyślny: `2 * 1024 * 1024 * 1024` (2 GiB) na vault. Uzasadnienie doboru: dwa disposable vaulty pilota + margines historii mieszczą się z zapasem w ~96 GB wolnego dysku `sapserver`, a jednocześnie limit jest na tyle niski, że pojedynczy klient nie zapełni ITX boxa (S6/threat model). Konfigurowalny per-vault (S5).
- **`MAX_VAULT_QUOTA_BYTES`** — twardy sufit konfiguracji, `64 * 1024 * 1024 * 1024` (64 GiB). Admin nie może ustawić quoty ponad ten sufit bez zmiany kodu; chroni przed przypadkowym `999999`, które unieważniłoby S6.
- **Granica per-plik pozostaje `DEFAULT_MAX_PAYLOAD_BYTES` (36 MiB)** — bez zmian. Ten plan nie podnosi granicy pojedynczego payloadu; per-plik enforcement quoty to istniejąca kontrola 36 MiB, a nowość to enforcement sumaryczny per-vault.
- Wszystkie limity domyślne definiowane jako eksportowane stałe obok istniejących (`DEFAULT_MAX_PAYLOAD_BYTES`), z override przez env (`HAVEMIND_VAULT_QUOTA_BYTES`) walidowanym tym samym `parseBoundedInteger` co `HAVEMIND_BODY_LIMIT_BYTES` (min 0, max `MAX_VAULT_QUOTA_BYTES`).

### S3. Egzekwowanie na ścieżce push (opaque, atomowe)

Nowy kod błędu w unii `SyncErrorCode` (`sync-routes.ts`): **`QUOTA_EXCEEDED`**, mapowany na HTTP **`413 Payload Too Large`** (semantycznie: zawartość odrzucona bo przekracza budżet magazynu; `413` jest właściwsze niż `507`, bo dotyczy budżetu logicznego vaultu, nie awarii dysku serwera — `507` rezerwujemy dla S6). Kod jest bez sekretów, oddzielony od tekstu ludzkiego (reguła: „Stable machine error codes are separate from human text").

Egzekwowanie **dwustopniowe**, żeby domknąć wyścig rozliczania i zamknąć wektor „osierocone bloby na dysku" (patrz threat model):

1. **Pre-check przed `blobStore.put`** (tania obrona przed zapisem na dysk): dla każdej rewizji w batchu, zanim payload trafi do `put`, serwer czyta bieżące `vaults.storage_bytes` i dolicza `blob_size` bajtów już zaakceptowanych w TYM batchu oraz rozmiar bieżącego payloadu, o ile jego `blob_hash` nie występuje jeszcze w vaulcie ani we wcześniej zaakceptowanym prefiksie batcha. Jeśli suma > `vault_quota_bytes` → rewizja odrzucona z `QUOTA_EXCEEDED` **bez wywołania `put`** (żaden bajt nie ląduje na dysku). Pre-check jest optymistyczny (poza transakcją), więc nie jest autorytatywny — służy tylko odcięciu zapisu dużych payloadów, które i tak by się nie zmieściły.
2. **Autorytatywny check wewnątrz `BEGIN IMMEDIATE`** w `commitRevision`: w tej samej transakcji, która wstawia rewizję/parents/heads/event/cursor (`plans/001` §8 „one `BEGIN IMMEDIATE` transaction"), po ustaleniu że `blob_hash` jest nowy dla vaultu, serwer liczy `storage_bytes + blob_size` i jeśli przekracza `vault_quota_bytes` → abort transakcji, zwrot `QUOTA_EXCEEDED`. Ponieważ better-sqlite3 ma jednego writera i `BEGIN IMMEDIATE` bierze zamek zapisu, check i inkrement licznika są niepodzielne — nie ma TOCTOU między odczytem `used` a zapisem rewizji.
3. **Inkrement licznika w tej samej transakcji:** przy akceptacji rewizji o nowym dla vaultu `blob_hash`, `UPDATE vaults SET storage_bytes = storage_bytes + ? WHERE id = ?`. Idempotentny retry (ten sam `revision_id`/`idempotency_key`) NIE inkrementuje ponownie — trafia w istniejącą ścieżkę idempotencji i zwraca oryginalny receipt, bo `blob_hash` już należy do vaultu. Rewizja o `blob_hash` już obecnym w vaulcie (dedup) NIE inkrementuje licznika.

`storage_bytes` to nowa kolumna: `ALTER TABLE vaults ADD COLUMN storage_bytes INTEGER NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0)` (migracja `002-*`, forward-only, idempotentnie zarejestrowana — `plans/001` §8/§CI). Migracja backfilluje `storage_bytes` kanonicznym zapytaniem z S1 dla każdego istniejącego vaultu w tej samej transakcji migracyjnej.

Granica opaque nienaruszona: serwer używa wyłącznie `blob_size` (który już liczy z odebranych bajtów) i `blob_hash`. Nie dekoduje, nie diffuje, nie interpretuje payloadu.

### S4. Interakcja z `blob-gc` (zwalnianie miejsca)

Dziś `sweepOrphanedBlobs` usuwa bloby, do których żadna rewizja (w żadnym vaulcie) nie referuje, wyłącznie na starcie. W modelu append-only pilota żadna rewizja nie znika, więc żaden blob nie staje się osierocony w normalnej pracy — quota rośnie monotonicznie aż do capa. To celowe i uczciwe (`plan/01` „Uczciwość jako feature"): klient dowiaduje się, że historia kosztuje miejsce, zanim zapełni vault.

Reguła spójności licznika względem GC: **`blob-gc` MUSI dekrementować `storage_bytes` każdego dotkniętego vaultu.** Ponieważ sweep jest globalny (blob osierocony = brak referencji w JAKIMKOLWIEK vaulcie), po ustaleniu listy usuwanych hashy sweep, w jednej transakcji z usunięciem rekordów, przelicza `storage_bytes` każdego vaultu kanonicznym zapytaniem S1 (rebuild, nie inkrementalny dekrement — prostsze i odporne na rozbieżność). W obecnym pilocie sweep i tak działa tylko na starcie przy pustym ruchu, więc pełny rebuild wszystkich `vaults.storage_bytes` na starcie jest tani i jednocześnie samonaprawiający licznik po każdym restarcie. **Decyzja: rebuild `storage_bytes` wszystkich vaultów jest częścią startowej sekwencji tuż po `sweepOrphanedBlobs`, przed przyjęciem połączeń.**

Kompaktowanie historii (usuwanie starych rewizji, by zwolnić quotę) jest POZA zakresem tego planu — należy do osobnego planu „encrypted checkpoints/retention" (`plans/001` §11 Faza 8 (d)). Ten plan świadomie NIE usuwa historii, by zwolnić miejsce; przy zapełnionym vaulcie klient dostaje `QUOTA_EXCEEDED` i musi poczekać na plan retencji albo owner podnosi quotę (S5) w granicach `MAX_VAULT_QUOTA_BYTES` i wolnego dysku.

### S5. Powierzchnia admin/owner (podgląd i ustawianie)

Zgodnie z `plans/001` §8 „local administrator diagnostics" — bez nowego publicznego API, bez React:

- **Odczyt (członek vaultu):** rozszerzenie istniejącej odpowiedzi listowania członkostwa/vaultu o pola `storageBytes` i `quotaBytes` (tylko dla aktywnego członka danego vaultu; deny-by-default jak reszta chronionych tras). Klient pokazuje „Xandnbsp;MB / Y GB użyte" w karcie połączenia.
- **Ustawianie (owner/admin lokalny):** komenda CLI serwera (obok `havemind doctor`/`backup`, `plans/001` §8), np. `havemind vault-quota <vaultId> --set <bytes>` i `havemind vault-quota <vaultId>` (odczyt). CLI waliduje `0 < bytes <= MAX_VAULT_QUOTA_BYTES`, zapisuje do nowej kolumny `vaults.quota_bytes` (migracja `002-*`: `ADD COLUMN quota_bytes INTEGER NOT NULL DEFAULT <domyślna> CHECK (quota_bytes >= 0 AND quota_bytes <= <MAX>)`), działa lokalnie na maszynie (bez zdalnego API mutującego quotę). Ustawienie quoty PONIŻEJ bieżącego `storage_bytes` jest dozwolone (blokuje nowe zapisy, nie kasuje historii) i wypisuje ostrzeżenie.
- Enforcement w S3 czyta `vaults.quota_bytes` (per-vault), z fallbackiem na `HAVEMIND_VAULT_QUOTA_BYTES`/domyślną stałą tylko dla vaultów utworzonych przed migracją (backfill migracji nadaje wszystkim wartość, więc fallback to tylko pas bezpieczeństwa).

### S6. Ochrona przed presją dyskową `sapserver` (free-disk guard)

Quota per-vault chroni budżet logiczny, ale nie chroni fizycznego dysku ITX boxa przed sumą wszystkich vaultów + WAL + backupy. Dlatego niezależny **free-disk guard**:

- Przed przyjęciem zapisu (na wejściu do trasy push, przed `put`), serwer sprawdza wolne miejsce na filesystemie data-root przez `statfs`/`fs.statfs`. Jeśli wolne < **`MIN_FREE_DISK_BYTES`** (domyślnie `2 * 1024 * 1024 * 1024`, 2 GiB, konfigurowalne `HAVEMIND_MIN_FREE_DISK_BYTES`) → cały push odrzucony z nowym kodem **`STORAGE_UNAVAILABLE`** → HTTP **`507 Insufficient Storage`**. Fail-closed (`plans/001` §8 „fails closed"): przy błędzie `statfs` serwer też odrzuca zapis.
- Guard jest per-request i tani (jedno `statfs`), sprawdzany raz na push (nie na rewizję). Odczyt (`GET events`/`GET blobs`) NIE jest blokowany — czytanie nie zwiększa presji dyskowej.
- To ostatnia linia obrony wspólna dla wszystkich vaultów i niezależna od quoty; chroni też WAL i katalog backupu na współdzielonym data-root.

## Threat model

Cytat bramki: powierzchnia sieciowa serwera staje się szerzej dostępna dopiero od **„Stage 2 — public technical alpha"** (`specs/003-open-source-release.md`, „## Release stages and gates"), kiedy repozytorium staje się publiczne i pojawia się „one-command server quick start" — inni self-hosterzy zaczynają uruchamiać ten kod na własnych maszynach. Dlatego ochrony DoS/presji dyskowej z tego planu (S3 pre-check, S6 free-disk guard) MUSZĄ być gotowe i przetestowane **przed** „Stage 2 — public technical alpha", nawet jeśli sama funkcja quoty formalnie realizuje bramkę Stage 3 („Attachment synchronization, quotas and retention behavior are implemented"). Pominięcie tych ochron oznaczałoby publikację kodu, który tani DoS zapełnieniem dysku kładzie na kolana — niedopuszczalne dla publicznego alfa quick startu.

### T1. Urządzenie zapełnia dysk (DoS)

- **Wektor A — jeden ogromny plik:** ograniczony istniejącym `DEFAULT_MAX_PAYLOAD_BYTES` (36 MiB) i `DEFAULT_BODY_LIMIT_BYTES` (40 MiB). Bez zmian.
- **Wektor B — wiele plików / historia:** klient pushuje setki różnych 25 MB plików albo w kółko modyfikuje jeden plik nowymi bajtami (append-only → każdy nowy `blob_hash` liczony). Obrona: quota per-vault (S3) zatrzymuje vault na `vault_quota_bytes`; po przekroczeniu każdy nowy blob → `QUOTA_EXCEEDED`.
- **Wektor C — osierocone bloby z odrzuconych rewizji (krytyczny, specyficzny dla tej ścieżki):** dziś `put` zapisuje payload na dysk PRZED `commitRevision`; gdyby quota była sprawdzana tylko w transakcji, klient mógłby pushować payloady odrzucane za quotę, a każdy z nich zdążyłby zapisać do 36 MiB na dysk (×64 na batch × wiele żądań), a osierocone bloby są zamiatane dopiero na starcie serwera — czyli nigdy w czasie ataku. **Obrona: pre-check S3 przed `put`** — payload, który na pewno nie zmieści się w quocie, nie jest w ogóle zapisywany. Dodatkowo S6 free-disk guard odcina cały push, gdy wolne miejsce spada poniżej progu, niezależnie od stanu quoty. **Nie wolno polegać na startowym sweepie jako obronie DoS w czasie rzeczywistym** — on istnieje do sprzątania po awariach, nie do odpierania ataku.

### T2. Wyścigi rozliczania quoty (quota-accounting races)

- **TOCTOU check-then-write:** dwa równoległe pushe do tego samego vaultu mogłyby oba przejść pre-check przy `used` tuż pod capem i oba zacommitować, przekraczając quotę. **Obrona:** autorytatywny check S3 jest WEWNĄTRZ `BEGIN IMMEDIATE`, a better-sqlite3 ma jednego writera z zamkiem zapisu — drugi commit widzi już zinkrementowane `storage_bytes` pierwszego i zostaje odrzucony. Pre-check poza transakcją jest tylko optymalizacją, nigdy jedyną barierą.
- **Podwójne liczenie retry:** idempotentny retry (ten sam `revision_id`) nie może inkrementować licznika dwa razy. **Obrona:** inkrement zachodzi tylko dla `blob_hash` nieobecnego jeszcze w vaulcie; retry trafia w istniejącą ścieżkę idempotencji (`plans/001` §7 „identical revision ID and identical blob digest returns the original result") i nie zmienia licznika.
- **Rozjazd licznik vs. rzeczywistość:** materializowany `storage_bytes` mógłby się rozjechać z kanonicznym zapytaniem S1 po awarii/restore. **Obrona:** rebuild wszystkich `vaults.storage_bytes` z S1 na starcie (S4), po restore (nowy `server_epoch`) i jako test spójności. Kanoniczne źródło prawdy to zawsze zapytanie S1, nigdy sam licznik.
- **Wyścig z blob-gc:** sweep i inkrement quoty na ścieżce push nie mogą się przeplatać. **Obrona:** sweep (i towarzyszący mu rebuild licznika) działa wyłącznie na starcie, gdy żaden push nie commituje (`blob-gc.ts` — istniejąca gwarancja); ten plan tej gwarancji nie łamie.

### T3. Interakcja z rate-limit-exempt blob GET

`GET /vaults/:vaultId/blobs/:blobHash` czyta blob bez rekomputacji hasha (`blob-store.ts` `read`/`#readExisting`) — świadomie tani na hot-path. Trasa jest chroniona (członkostwo w vaulcie, `blobBelongsToVault` — cross-vault probing nic nie uczy). Zagrożenia i ich stan:

- **Amplifikacja odczytu:** członek może wielokrotnie pobierać duże bloby. Quota NIE ogranicza odczytu (to budżet magazynu, nie transferu). To poza zakresem tego planu — należy do warstwy rate-limitingu (`plans/001` §8 „Rate limits apply before authentication and per authenticated member/device"). Ten plan tego NIE osłabia i tego NIE naprawia; jawnie odnotowane jako granica.
- **GET nie zwiększa presji dyskowej:** dlatego S6 free-disk guard celowo NIE blokuje odczytu — blokowanie GET przy niskim dysku tylko utrudniłoby klientom pobranie i zwolnienie stanu, nie pomogłoby dyskowi.
- **Quota nie tworzy nowego kanału wycieku przez GET:** ekspozycja `storageBytes`/`quotaBytes` (S5) jest ograniczona do aktywnego członka danego vaultu; nie ujawnia danych innych vaultów ani treści. Brak nowego IDOR: te same kontrole członkostwa co istniejące trasy.

## Acceptance tests

Wszystkie testy funkcjonalne, RED-first (reguła 2), na realnym tymczasowym SQLite + katalogu blobów (`plans/001` §12 „Integration"). Oznaczenia AT-n.

- **AT-1 (rozliczanie append-only):** utwórz vault z `quota_bytes = 100`. Push rewizji z blobem 60 B (nowy plik) → akceptacja, `storage_bytes = 60`. Push drugiej rewizji tego samego pliku z blobem 60 B (inny `blob_hash`, modyfikacja) → **`QUOTA_EXCEEDED` (413)**, bo 60+60 > 100 mimo że to „nadpisanie". `storage_bytes` pozostaje 60. Dowodzi, że historia liczy się w całości.
- **AT-2 (dedup nie podwaja):** `quota_bytes = 100`. Push blobu 60 B do pliku A → akceptacja. Push identycznych bajtów (ten sam `blob_hash`) do pliku B → akceptacja, `storage_bytes` nadal 60. Dowodzi liczenia po DISTINCT `blob_hash`.
- **AT-3 (idempotentny retry nie inkrementuje):** push rewizji 60 B → akceptacja, `storage_bytes = 60`. Powtórz identyczny push (ten sam `revision_id`/`idempotencyKey`) → ten sam receipt, `storage_bytes` nadal 60.
- **AT-4 (granica dokładna):** `quota_bytes = 120`, blob 60 B → OK (used 60), drugi inny blob 60 B → OK (used 120, dokładnie na granicy), trzeci blob 1 B → `QUOTA_EXCEEDED`. Dowodzi, że `<=` cap jest dozwolone, `>` odrzucone.
- **AT-5 (pre-check nie zapisuje na dysk — obrona T1/C):** `quota_bytes = 10`. Push batcha z payloadem 25 MB (nowy `blob_hash`) → `QUOTA_EXCEEDED`, a katalog blobów NIE zawiera pliku o tym hashu (`listHashes` go nie zwraca). Dowodzi, że odrzucony przez quotę payload nie ląduje na dysku.
- **AT-6 (autorytatywność w transakcji — wyścig T2):** dwa równoległe pushe różnych blobów po 60 B do vaultu z `quota_bytes = 100`, każdy przechodzący pre-check przy `used = 0`. Dokładnie jeden zostaje zaakceptowany, drugi → `QUOTA_EXCEEDED`; końcowy `storage_bytes = 60`, nigdy 120. (Symulacja przez wstrzyknięcie punktu przeplotu między pre-checkiem a commitem, spójnie z istniejącymi crash-point testami.)
- **AT-7 (kod i status błędu stabilny, bez sekretów):** odrzucony za quotę push zwraca dokładnie `{ error: { code: "QUOTA_EXCEEDED" } }` z HTTP 413 i `cache-control: no-store`; body nie zawiera ścieżek, rozmiarów innych vaultów ani tekstu ludzkiego.
- **AT-8 (rebuild licznika = kanoniczne zapytanie):** po serii akceptacji zepsuj ręcznie `vaults.storage_bytes` (ustaw 0), zrestartuj serwer → po starcie `storage_bytes` równa się wynikowi kanonicznego zapytania S1. Dowodzi samonaprawy licznika.
- **AT-9 (blob-gc dekrementuje):** (test przygotowawczy pod retencję) po sweepie usuwającym blob, do którego nie ma już żadnej rewizji, `storage_bytes` dotkniętych vaultów odpowiada kanonicznemu zapytaniu S1. W obecnym append-only pilocie sweep nic nie usuwa — test tworzy sztuczny osierocony blob (rewizja odrzucona przed commitem) i weryfikuje, że po starcie licznik i tak zgadza się z S1.
- **AT-10 (free-disk guard — S6/T1):** przy zamockowanym `statfs` zwracającym wolne < `MIN_FREE_DISK_BYTES` push zwraca `STORAGE_UNAVAILABLE` (507) i NIE wywołuje `put`; `GET events` i `GET blobs` w tym samym stanie działają normalnie (200). Przy błędzie `statfs` push też → 507 (fail-closed).
- **AT-11 (CLI admin ustawia i czyta quotę):** `havemind vault-quota <id> --set N` zapisuje `quota_bytes = N`; ustawienie `N > MAX_VAULT_QUOTA_BYTES` → błąd walidacji, brak zapisu; ustawienie `N < storage_bytes` → zapis + ostrzeżenie, kolejne pushe odrzucone `QUOTA_EXCEEDED`, historia nietknięta.
- **AT-12 (ekspozycja tylko dla członka):** listowanie vaultu zwraca `storageBytes`/`quotaBytes` aktywnemu członkowi; nie-członek (obcy `session`) → istniejące `FORBIDDEN (403)`, bez wycieku liczb.
- **AT-13 (migracja backfill):** na bazie z istniejącymi rewizjami sprzed migracji `002-*`, po migracji `vaults.storage_bytes` każdego vaultu == kanoniczne zapytanie S1, a `quota_bytes` == wartość domyślna; migracja idempotentnie zarejestrowana, powtórny start nie zmienia wartości.

## Rollout/rollback

### Kolejność wdrożenia (forward-only, jeden PR na spójny krok)

1. **Migracja `002-quota.sql`** (`apps/server/src/migrations/`): `ALTER TABLE vaults ADD COLUMN storage_bytes ...`, `ADD COLUMN quota_bytes ...`, backfill obu kolumn kanonicznym zapytaniem S1 w transakcji migracyjnej. Uporządkowana, transakcyjna, idempotentnie zarejestrowana, testowana z origin = obecny schemat (`plans/001` §CI „SQLite migrations are ordered, transactional ..., idempotently recorded and tested from every supported upgrade origin"). Test: AT-13.
2. **Stałe i config:** `DEFAULT_VAULT_QUOTA_BYTES`, `MAX_VAULT_QUOTA_BYTES`, `MIN_FREE_DISK_BYTES` + parsowanie `HAVEMIND_VAULT_QUOTA_BYTES`/`HAVEMIND_MIN_FREE_DISK_BYTES` przez istniejący `parseBoundedInteger`.
3. **Enforcement w repository/sync-routes:** kod `QUOTA_EXCEEDED` + mapowania status/sync-code; pre-check + autorytatywny check + inkrement w `commitRevision`; free-disk guard `STORAGE_UNAVAILABLE`. Testy AT-1..AT-10.
4. **Rebuild licznika na starcie** tuż po `sweepOrphanedBlobs` + po restore. Test AT-8, AT-9.
5. **CLI + ekspozycja odczytu** w listowaniu vaultu. Testy AT-11, AT-12.
6. Gate lokalny (kolejność krytyczna): `npm run build` → `npm run typecheck` → eslint na dotkniętych plikach → `npm test` → `npm run test:integration`. Rebuild zmienionych pakietów workspace przed testami downstream, jeśli konsumują `dist/`.

### Deploy na `sapserver`

Zgodnie z ustaloną granicą operacyjną: agent robi tylko operacje nieuprzywilejowane (rsync źródeł); **rebuild Dockera i restart wykonuje user** (operacje wymagające `docker`/`sudo` — reguła 9 z `plan/01-zasady-i-slownik.md`). Sekwencja redeployu bez zmian względem obecnej (rebuild kontenera → reload obu wtyczek → smoke-test z sync załącznika), rozszerzona o smoke-test przekroczenia quoty na jednym disposable vaulcie. Restart uruchamia migrację `002-*` i rebuild licznika automatycznie.

### Rollback

- **Kod:** ten plan nie zmienia formatu payloadu, koperty rewizji ani granicy opaque — poprzedni obraz kontenera czyta tę samą bazę. Rollback = przywrócenie poprzedniego obrazu; nowe kolumny `vaults.storage_bytes`/`quota_bytes` są ignorowane przez starszy kod (SQLite toleruje nadmiarowe kolumny). Brak downgrade migracji (`specs/003` „Database downgrade migrations are not promised", `plans/001` §8 „Rollback uses the matching prior image and backup, never an in-place schema downgrade").
- **Awaryjne wyłączenie egzekwowania bez rollbacku kodu:** ustaw `HAVEMIND_VAULT_QUOTA_BYTES` (lub per-vault `quota_bytes` przez CLI) na `MAX_VAULT_QUOTA_BYTES` i `HAVEMIND_MIN_FREE_DISK_BYTES=0` → quota i free-disk guard praktycznie nieaktywne, bez zmiany kodu. Przydatne, gdyby enforcement fałszywie blokował pilota.
- **Backup przed migracją:** wymagany zweryfikowany backup przed pierwszą nieodwracalną migracją (`specs/003`, `plans/001` §8). Operacje nieodwracalne na backupie (`restic forget --prune`, `docker compose down --volumes`) — zawsze pytanie do usera (reguła 9).
- **Bramka bezpieczeństwa:** ochrony DoS/presji dyskowej (S3 pre-check, S6) muszą być zielone w CI **przed** „Stage 2 — public technical alpha"; sama funkcja quoty formalnie domyka bramkę „Stage 3 — general beta". Publikacja repo/Release/Obsidian — zawsze pytanie do usera (reguła 9, `plans/001` §14 „Ask first").
