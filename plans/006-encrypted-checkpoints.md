# Havemind — plan follow-up: encrypted checkpoints (F9)

- Status: **Szkic follow-up (F9-01)** — do zatwierdzenia przez ownera przed implementacją.
- Data: 2026-07-24
- Rozszerza: `plans/001-technical-plan.md` §7 (offline delivery — „Real-vault compaction
  requires an encrypted checkpoint"), §8 (backup/restore), §10 (E2EE); realizuje bramkę
  `specs/003-open-source-release.md` **Stage 3 — general beta (`0.5.x`)** wiersz „Supported
  backup and restore work on a clean machine".
- Komponuje się z: `plans/004-*` (E2EE/device recovery). Ten plan zakłada, że E2EE już istnieje
  albo że checkpoint działa też dla plaintextowego pilotażu jako degradacja (patrz `## Spec`,
  „Tryby").
- Relacja do backlogu: domyka część F9-01; warstwa aplikacyjna, którą Restic (SRV-03/04/05,
  **ODROCZONE** decyzją ownera 2026-07-16 — zero zewnętrznego/chmurowego backupu, dane wyłącznie
  na sprzęcie usera) opakowałby bez znajomości treści.

## Dane kanoniczne i granice (nie negocjowalne)

Zgodnie z `plan/01-zasady-i-slownik.md` reguła 1 — przy sprzeczności wygrywają `specs/`/`plans/`.
Ten plan nie zmienia żadnej z poniższych granic, tylko dokłada warstwę:

- **Serwer opaque** (`plans/001` §3, reguła 3): proces Havemind buduje checkpoint z bajtów,
  które już przechowuje (blob store + `havemind.db`). Nie liczy diffa, provenance ani merge'a,
  nie zna treści payloadów. Checkpoint to operacja I/O + kryptografia biblioteczna, nie
  interpretacja treści.
- **Zero własnej kryptografii** (`plans/001` §14 „Never: invent cryptography", §10): szyfrowanie
  metadanych i uwierzytelnianie integralności realizuje wyłącznie sprawdzona biblioteka
  (kandydat: `age` / `rage` jako format pliku, albo libsodium `crypto_secretstream` przez
  Node `sodium-native`; wybór i wektory testowe wymagają osobnego spike'u jak w `plans/001` §10).
  Żaden własny prymityw, żaden własny tryb łańcuchowania.
- **Brak zakazanych zależności**: bez Reacta, Redisa, PostgreSQL, message brokera, ORM-a,
  Kubernetes ani własnej kryptografii (`plans/001` §5, §14). Checkpoint pisze better-sqlite3 +
  Node fs + biblioteka szyfrująca — nic więcej.
- **Ograniczenia `sapserver`** (reguła 7): 16 GB RAM, ~96 GB wolnego dysku, brak grupy `docker`,
  brak publicznych portów. Checkpoint musi mieścić retencję w budżecie dysku i nie zakładać
  drugiej maszyny.
- **Pilot: bez chmury, dane tylko na sprzęcie usera** (reguła w `01` „Uczciwość jako feature";
  SRV-02/03 decyzja ownera). Checkpoint zapisywany jest na dysk `sapserver` i kopiowany na
  sprzęt usera (USB / SFTP na Maca / NAS w LAN) — nigdy do usługi chmurowej.

## Spec

### Cel

Okresowy, samowystarczalny, zaszyfrowany snapshot całego stanu jednego deploymentu Havemind,
z którego owner może odtworzyć instancję na czystej maszynie **bez udziału jakiejkolwiek strony
trzeciej** (bez chmury, bez zewnętrznej usługi kluczy, bez `sapserver` w roli źródła zaufania).
Checkpoint jest warstwą aplikacyjną: kompletną, zweryfikowaną jednostką „stan na moment T",
którą narzędzie transportu/retencji (docelowo Restic, gdy wróci z odroczenia) tylko przenosi
i wersjonuje, nie rozumiejąc jej wnętrza.

### Co zawiera checkpoint

Jeden checkpoint = katalog/archiwum z trzema częściami (odzwierciedla podział z `plans/001` §8
„database snapshot paired with a manifest of every referenced blob"):

1. **`havemind.db.enc`** — snapshot bazy metadanych SQLite pobrany przez **SQLite Online Backup
   API** (nigdy surowa kopia aktywnego pliku + WAL — `plans/001` §8), następnie **zaszyfrowany
   w spoczynku** biblioteką (patrz „Zarządzanie kluczem"). Baza metadanych obejmuje:
   sekwencje/kursory, `server_sequence`, użytkowników, urządzenia, vaulty, membershipy,
   zaproszenia (hash), rodziny refresh-tokenów (hash), pliki, rewizje, rodziców rewizji,
   zdarzenia, rejoin grants, epokę instancji/restore. **Te dane NIE są E2EE** — są jawnym
   metadanymi po stronie serwera — dlatego checkpoint musi dać im własne szyfrowanie w spoczynku.
2. **`blobs/`** — content-addressed bloby rewizji (payload envelope'ów). Po wdrożeniu E2EE
   (`plans/004`) blob to authenticated ciphertext — **zaszyfrowany z konstrukcji**, checkpoint
   kopiuje bajty bez ponownego szyfrowania. W trybie plaintextowego pilotażu blob jest jawny;
   patrz „Tryby". Każdy blob nazwany swoim `blob_hash` (SHA-256 przechowywanych bajtów,
   `plans/001` §7).
3. **`manifest.json`** (minimalny, jawny, uwierzytelniony) — bez treści notatek, bez sekretów.
   Pola: `checkpoint_format_version`; `created_at`; `instance_id`; `server_epoch`; `schema_version`
   / `server_version`; `max_server_sequence`; lista `{ blob_hash, size }` dla każdego
   referowanego bloba; `db_ciphertext_hash` (SHA-256 zaszyfrowanego pliku bazy); identyfikator
   suity kryptograficznej i KDF (`kdf`, `cipher_suite`, `key_epoch`); `history_commitment`
   (deterministyczny hash łańcucha rewizji, zgodnie z „history commitment" z `plans/001` §7).
   Manifest jest **uwierzytelniony** (MAC/podpis nad jego bajtami tym samym kluczem checkpointu),
   żeby wykryć manipulację przy odtwarzaniu.

Manifest jest jawny celowo: pełni rolę „spisu treści" dla weryfikacji integralności i dla
narzędzia retencji, ale nie może ujawniać niczego wrażliwego (żadnych ścieżek plaintext, treści,
tokenów) — to jest AC bezpieczeństwa.

### Zarządzanie kluczem (oddzielony od klucza E2EE vaultu)

- **Osobny klucz `checkpoint_key`**, niezależny od `vault_key` z `plans/004`. Uzasadnienie:
  E2EE chroni treść notatek przed serwerem; checkpoint chroni **metadane serwera** (których
  serwer z definicji musi znać w plaintext w czasie działania). To dwie różne granice zaufania
  i dwa różne cykle życia (rotacja klucza vaultu przy usunięciu membera ≠ rotacja klucza kopii).
- **Klucz trzyma owner**, nie serwer w postaci użytkowej. Model: owner ma sekret odtwarzalny
  (passphrase o wysokiej entropii wygenerowana lokalnie + zapisana w recovery kit — analogicznie
  do recovery kit z `plans/001` §10). `checkpoint_key` wyprowadzany jest z tego sekretu przez
  **biblioteczny KDF odporny na brute-force** (Argon2id z libsodium / mechanizm `age` — bez
  własnego KDF).
- **Serwer, który tworzy checkpoint automatycznie**, potrzebuje móc szyfrować bez interakcji.
  Rozwiązanie bez oddania pełnej kontroli serwerowi: klucz szyfrowania checkpointu to klucz
  **publiczny odbiorcy** (schemat asymetryczny biblioteki, np. `age` recipient X25519). Serwer
  ma tylko publiczny recipient — może szyfrować nowy checkpoint, ale **nie może odszyfrować
  żadnego** (nie ma klucza prywatnego). Deszyfrowanie i restore wykonuje owner swoim kluczem
  prywatnym z recovery kit, na czystej maszynie. To realizuje „bez strony trzeciej":
  `sapserver` może zostać przejęty i wciąż nie odczyta własnych checkpointów.
- Klucz prywatny / passphrase **nigdy** nie trafia do repo, logów, `havemind.db`, ani do raportu
  subagenta (`plan/01` reguła 6). Serwer przechowuje wyłącznie publiczny recipient w pliku
  konfiguracyjnym `/srv/secrets` (jak inne sekrety w F7-03), z uprawnieniami 0600.

### Kadencja i retencja

- **Kadencja**: konfigurowalny interwał (domyślnie raz na dobę), wyzwalany harmonogramem serwera
  (nie zewnętrznym cronem wymagającym `sudo`). Dodatkowo checkpoint **przed każdą migracją/
  upgrade** (spójne z `plans/001` §8 „Every upgrade creates or requires a verified backup before
  the first irreversible migration").
- **Wzajemne wykluczenie**: podczas składania checkpointu blokowane są purge i garbage collection
  blobów (`plans/001` §8 „Purge and blob GC are locked out while a backup snapshot is assembled").
  Checkpoint bierze snapshot bazy przez Online Backup API, więc równoległe writy nie psują pliku.
- **Retencja** (domyślna, zgodna z odroczonym fundamentem Restic 7/4/6 z SRV-03): 7 dziennych,
  4 tygodniowe, 6 miesięcznych. Retencja liczona lokalnie; usunięcie starego checkpointu to
  operacja odwracalna dopiero po weryfikacji nowszego (nigdy „forget" bez wcześniejszego
  „verify" — analogicznie do `restic check` przed `forget`, `plan/01` reguła 9).
- **Budżet dysku** (reguła 7): retencja musi mieścić się w ~96 GB. Blob store jest
  content-addressed i współdzielony między checkpointami przez hash — implementacja może
  hardlinkować/dedupikować niezmienione bloby między kolejnymi checkpointami zamiast kopiować
  je N razy (to samo, co potem robi Restic warstwą wyżej). Alarm i wpis w `DECISIONS.md` przy
  przyroście > 20 GB (spójne z checklistą pilotażu F8-02).
- **Kopia poza dysk systemowy serwera** (`plans/001` §8 „stored off the server's physical disk"):
  gotowy, zaszyfrowany checkpoint jest kopiowany na sprzęt usera (USB / SFTP na Maca / NAS w LAN).
  Ten transport to miejsce, w które wejdzie Restic po powrocie z odroczenia — Restic opakuje
  **już zaszyfrowane** checkpointy, nie widzi plaintextu.

### Procedura restore + weryfikacja integralności

Restore celuje w **nowy, pusty, izolowany katalog danych** (`plans/001` §8). Kroki, wszystkie
**przed** wejściem serwera w stan gotowości:

1. Owner dostarcza klucz prywatny / passphrase z recovery kit na czystej maszynie. Deszyfrowanie
   `havemind.db.enc` → `havemind.db` biblioteką (weryfikacja tagu AEAD/MAC — niepoprawny tag =
   przerwanie, nic nie startuje).
2. **`PRAGMA integrity_check`** na odszyfrowanej bazie — musi zwrócić `ok` (`plans/001` §8;
   AC F7-01 już to egzekwuje dla backupu, checkpoint dziedziczy ten warunek).
3. **Weryfikacja manifestu**: MAC/podpis manifestu poprawny; `db_ciphertext_hash` zgadza się
   z bajtami `havemind.db.enc`.
4. **Bajt-hash każdego bloba**: dla każdego wpisu w manifeście policz SHA-256 pliku w `blobs/`
   i porównaj z `blob_hash` oraz `size`. Dodatkowo referential integrity: każdy blob referowany
   przez SQLite istnieje i odwrotnie żaden blob w checkpoincie nie jest osierocony poza polityką
   GC (`plans/001` §8 „GC never deletes a blob still referenced by SQLite").
5. Dopiero po przejściu 1–4 instancja startuje z **nową `server_epoch`** (`plans/001` §8),
   unieważnia wcześniejsze sesje i wymusza na klientach z młodszą epoką lub kursorem poza serwer
   pojednanie `revision_id`/heads przed dalszą mutacją (dokładnie ścieżka przetestowana w F7-01).

Każde niepowodzenie kroku 1–4 = restore przerwany, epoka niezmieniona, żaden plik nie
zmaterializowany (fail-closed).

### Tryby (plaintext pilot vs E2EE)

- **Tryb E2EE** (docelowy, wymagany do Stage 3): bloby to ciphertext (`plans/004`), szyfrowana
  jest tylko baza metadanych. Checkpoint jako całość jest w spoczynku zaszyfrowany z konstrukcji
  + osobne szyfrowanie bazy.
- **Tryb plaintext pilot**: bloby jawne. Żeby checkpoint pozostał samowystarczalnie zaszyfrowany
  w spoczynku, cały katalog checkpointu (baza + `blobs/`) jest szyfrowany `checkpoint_key`.
  To jednak **nie** czyni pilotażu „bezpiecznym dla prawdziwych notatek" — pilot pozostaje
  disposable-only (`plan/01` „Uczciwość jako feature"; `plans/001` §10 „A disposable plaintext
  pilot vault is never upgraded in place into a real encrypted vault"). Checkpoint plaintextowego
  vaultu nigdy nie jest przedstawiany jako gwarancja poufności prawdziwych danych.

## Threat model

Model rozszerza dokumentowany threat model deploymentu (`specs/003` „A threat model documents
what the server administrator, network provider and collaborators can observe"). Bramka
**Stage 3 — general beta (`0.5.x`)** z `specs/003-open-source-release.md` wymaga wprost:
„Supported backup and restore work on a clean machine" oraz „A security review and documented
threat-model review are complete" — ten rozdział jest częścią tej dokumentacji i musi zostać
przejrzany, zanim checkpointy zostaną uznane za spełniające bramkę Stage 3 — general beta.

| # | Zagrożenie | Aktor / wektor | Kontrola |
|---|---|---|---|
| T1 | **Kradzież checkpointu (poufność w spoczynku)** | Kradzież dysku `sapserver`, USB, udziału NAS albo przechwycenie kopii w transporcie | `havemind.db.enc` zaszyfrowana biblioteczną AEAD z kluczem, którego serwer nie posiada (recipient publiczny); w trybie plaintext całość checkpointu zaszyfrowana `checkpoint_key`; manifest bez treści/sekretów. Przejęcie samego `sapserver` nie ujawnia checkpointów, bo brak na nim klucza prywatnego. |
| T2 | **Zmanipulowany checkpoint (integralność/autentyczność przy restore)** | Podmiana bajtów bazy, bloba albo manifestu przez atakującego z dostępem do miejsca składowania | Tag AEAD/MAC bazy weryfikowany przy deszyfrowaniu; manifest uwierzytelniony (MAC/podpis); `PRAGMA integrity_check`; bajt-hash każdego bloba vs `blob_hash`+`size`; `db_ciphertext_hash` w manifeście. Dowolna niezgodność → restore przerwany fail-closed, epoka niezmieniona. Serwer opaque nie może „naprawić" ani sfabrykować treści (`plans/001` §8). |
| T3 | **Utrata klucza** | Owner traci passphrase / klucz prywatny recovery kit | Klucz jest jedynym sposobem odczytu — utrata = trwała niemożność restore (świadomy koszt modelu „bez strony trzeciej", tak jak recovery kit E2EE w `plans/001` §10). Kontrola procesowa: recovery kit generowany lokalnie przy pierwszym uruchomieniu, jego istnienie i przechowywanie poza `sapserver` jest częścią checklisty Stage 3; brak backdoora ani „server-side recovery" (serwer nie może odszyfrować — `plans/001` assumption 6 „The server cannot recover or decrypt vault contents"). Dokumentacja jawnie ostrzega, że utrata klucza jest nieodwracalna — uczciwość zamiast fałszywej obietnicy odzysku. |
| T4 | **Częściowy / uszkodzony checkpoint** | Przerwane zapisywanie (crash, brak miejsca), bit rot na nośniku, obcięta kopia | Checkpoint publikowany atomowo: zapis do pliku tymczasowego na tym samym filesystemie, `fsync`, atomic rename, `fsync` katalogu rodzica (wzorzec publikacji blobów z `plans/001` §8); checkpoint uznany za ważny dopiero po zapisaniu i zweryfikowaniu manifestu. Przy restore pełna weryfikacja (kroki 1–4) wychwytuje brakujący/obcięty blob lub bazę → odrzucenie i próba ze starszego checkpointu z retencji. Retencja (7/4/6) zapewnia, że jeden zepsuty checkpoint nie jest jedyną kopią. „Forget" starego dopiero po „verify" nowszego. |
| T5 | **Metadane w manifeście jako wyciek** (poboczne do T1) | Atakujący czyta jawny `manifest.json` | Manifest zawiera wyłącznie hashe, rozmiary, wersje, epokę — zero ścieżek plaintext, treści notatek, tokenów, zaproszeń. Egzekwowane testem redakcji (jak diagnostyka w F7-03). |

Poza zakresem (zgodnie z `plans/001` §7 „Attribution is deterministic collaboration history, not
forensic proof against a malicious collaborator or administrator"): checkpoint nie chroni przed
złośliwym ownerem, który ma klucz prywatny — to jest z definicji rola zaufana. Chroni przed
przejęciem infrastruktury i nośników.

## Acceptance tests

Wszystkie testy funkcjonalne i weryfikowalne (TDD red-green-refactor, `plan/01` reguła 2).
Metody podane wprost.

1. **Restore na czystą instancję jest bajt-w-bajt identyczny** — utwórz deployment z N rewizjami
   i M blobami, zrób checkpoint, odtwórz na pustym izolowanym katalogu na „czystej maszynie"
   (fixture). AC: każdy blob w odtworzonej instancji jest bajt-w-bajt identyczny z oryginałem
   (`diff`/SHA-256 per blob → 0 różnic); zbiór `revision_id`/`server_sequence`/heads identyczny.
   (Realizuje `specs/003` Stage 3 — general beta „backup and restore work on a clean machine".)
2. **`PRAGMA integrity_check` czysty po restore** — po deszyfrowaniu bazy z checkpointu
   `PRAGMA integrity_check` zwraca dokładnie `ok`. AC: wynik = `ok`; przy sztucznie uszkodzonej
   bazie test oczekuje przerwania restore przed startem (fail-closed).
3. **Poufność w spoczynku (T1)** — grep surowych bajtów `havemind.db.enc` (i, w trybie plaintext,
   całego archiwum) na znane markery treści/tokenów wstrzyknięte do fixture'u → 0 trafień.
   AC: bez klucza prywatnego deszyfrowanie zwraca błąd, nie plaintext.
4. **Wykrycie manipulacji (T2)** — po utworzeniu checkpointu odwróć jeden bajt (a) w bazie,
   (b) w jednym blobie, (c) w manifeście; uruchom restore. AC: każdy z trzech przypadków →
   restore przerwany, `server_epoch` niezmieniona, zero zmaterializowanych plików; komunikat
   błędu bez wycieku treści.
5. **Bajt-hash blobów w manifeście** — dla świeżego checkpointu policz SHA-256 każdego pliku
   w `blobs/` i porównaj z manifestem. AC: 100% zgodność `blob_hash`+`size`; blob referowany
   przez SQLite ale nieobecny w `blobs/` → restore odrzucony (referential integrity).
6. **Nowa epoka + wymuszone pojednanie** — po restore instancja ma nową `server_epoch`; klient
   ze starym kursorem dostaje odpowiedź wymuszającą pojednanie (regresja wobec F7-01:
   `409 CURSOR_INVALID` end-to-end po HTTP). AC: stary cursor → pojednanie przed jakąkolwiek
   mutacją.
7. **Atomiczność / częściowy checkpoint (T4)** — wstrzyknij crash między zapisem a renamem
   pliku tymczasowego. AC: brak „półgotowego" checkpointu widocznego jako ważny; ostatni ważny
   checkpoint pozostaje kompletny i przechodzi restore.
8. **Retencja 7/4/6 i „verify przed forget"** — po serii checkpointów polityka utrzymuje
   7 dziennych/4 tygodniowe/6 miesięcznych. AC: liczba i wybór checkpointów zgodne z polityką;
   próba usunięcia najstarszego bez uprzedniej udanej weryfikacji nowszego → zablokowana.
9. **Serwer nie potrafi odszyfrować własnego checkpointu (T1/model bez strony trzeciej)** — mając
   tylko materiał, który serwer przechowuje (publiczny recipient), próba deszyfrowania →
   niemożliwa/błąd. AC: deszyfrowanie udaje się wyłącznie z kluczem prywatnym ownera.
10. **Manifest bez sekretów (T5)** — grep `manifest.json` na wstrzyknięte do fixture'u ścieżki
    plaintext, tokeny i treść notatek → 0 trafień (wzorzec testu redakcji z F7-03).
11. **Wzajemne wykluczenie z GC/purge** — checkpoint składany równolegle ze ścieżką GC:
    AC: GC/purge nie usuwa bloba referowanego przez powstający checkpoint; snapshot bazy przez
    Online Backup API jest spójny mimo równoległych writeów.

## Rollout/rollback

### Warunki wejścia

- E2EE (`plans/004`) zaimplementowane i przeszłe multi-device recovery testy — bo Stage 3 —
  general beta wiąże E2EE i backup razem. W trybie plaintext checkpoint może powstać wcześniej
  jako fundament, ale **nie odblokowuje** Stage 3.
- F7-01 (backup/restore + server epoch) ukończone — checkpoint dziedziczy jego Online Backup API,
  weryfikację manifestu i ścieżkę epoki (jest już `[x]` w backlogu).
- Osobny spike suity kryptograficznej + wektory testowe wybrane i przejrzane (jak `plans/001`
  §10 „require a dedicated threat-model spike and test vectors. No custom cryptographic
  primitive will be invented"). **Bramka decyzyjna ownera** przed wdrożeniem (reguła 9: zmiana
  zatwierdzonego modelu szyfrowania/zaufania zawsze wymaga pytania).

### Kolejność wdrożenia (za `plans/001` §11, sekwencyjnie, TDD)

1. Format checkpointu + manifest + testy integralności na fixture'ach (bez szyfrowania) — RED→GREEN.
2. Warstwa szyfrowania biblioteczna (KDF + AEAD/recipient), wektory testowe, testy poufności
   (T1) i manipulacji (T2).
3. Atomiczna publikacja + crash-testy (T4) + wzajemne wykluczenie z GC.
4. Harmonogram + retencja 7/4/6 + budżet dysku + kopia poza dysk serwera.
5. Restore na czystą instancję end-to-end (AC 1,2,6) + dokumentacja recovery kit i utraty klucza (T3).
6. Dopiero po zieleni całości: przegląd threat-model (wymóg Stage 3 — general beta), potem
   ewentualne opakowanie Resticiem (SRV-03/04/05 po powrocie z odroczenia) — Restic transportuje
   już zaszyfrowane checkpointy, nie zmienia ich zawartości.

### Rollback

- Checkpoint jest **addytywny i nieniszczący**: nie modyfikuje działającej bazy ani blob store'u
  (czyta przez Online Backup API + kopiuje bloby po hashu). Wyłączenie funkcji = zatrzymanie
  harmonogramu; istniejące checkpointy pozostają ważne i odtwarzalne. Brak migracji schematu bazy
  wymaganej przez sam mechanizm checkpointu → brak downgrade migracji do cofania (spójne z
  `plans/001` §8 „Rollback uses the matching prior image and backup, never an in-place schema
  downgrade").
- Jeśli nowy format checkpointu okaże się wadliwy: `checkpoint_format_version` w manifeście
  pozwala restore'owi rozpoznać i odrzucić nieobsługiwaną wersję fail-closed; starsze checkpointy
  poprzedniej wersji pozostają odtwarzalne poprzednim obrazem kontenera (immutable tags,
  `specs/003`).
- Nieodwracalne operacje na checkpointach (usunięcie, `forget --prune`) wymagają pytania ownera
  (`plan/01` reguła 9) i zawsze poprzedza je udana weryfikacja nowszego checkpointu.
- Awaria restore nie dotyka źródła: restore celuje w nowy pusty katalog, więc nieudana próba
  nie uszkadza działającej instancji ani innych checkpointów (fail-closed, izolacja z `plans/001` §8).
