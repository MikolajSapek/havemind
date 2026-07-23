# Havemind — szyfrowanie E2EE treści vaultu i ścieżka odzyskiwania

- Status: **Szkic planu (do zatwierdzenia)**
- Data: 2026-07-24
- Implementuje bramkę: `specs/003-open-source-release.md` → **Stage 3 — general beta** (`0.5.x`)
- Realizuje twardy warunek dostępu publicznego z: `specs/002-public-access.md`
- Rozszerza: `plans/001-technical-plan.md` §7 (revision envelope), §10 (E2EE compatibility path)
- Podlega: `plan/01-zasady-i-slownik.md` (zasady twarde), `CLAUDE.md` (skrót twardych reguł)

Ten dokument NIE zmienia protokołu rewizji ani modelu opaque serwera. Projektuje jedynie
zawartość `opaque_payload` (plaintext → ciphertext) oraz zarządzanie kluczami i odzyskiwaniem,
w granicach już zatwierdzonych w `plans/001-technical-plan.md` §10. Sprzeczność między tym
plikiem a `specs/`/`plans/001` → wygrywają `specs/`/`plans/001` (`plan/01` reguła 1).

---

## Spec

### Cel i bramka

E2EE treści vaultu i historia odzyskiwania to twarda bramka `specs/002-public-access.md`
(bez E2EE nie ma dostępu publicznego do prawdziwych vaultów) oraz wprost wymóg
**Stage 3 — general beta** z `specs/003-open-source-release.md` „## Release stages and gates":

> „End-to-end encryption for note contents and attachments passes multi-device recovery tests."

Ten plan dostarcza projekt, który tę bramkę spełnia. Pierwszy prawdziwy vault powstaje jako
E2EE od pierwszej rewizji — `plans/001-technical-plan.md` §10: „A disposable plaintext pilot
vault is never upgraded in place into a real encrypted vault."

### Twarde ograniczenia (MUSZĄ obowiązywać — powtórzone tu jawnie)

1. **Serwer pozostaje opaque.** Serwer Havemind przechowuje wyłącznie bajty adresowane treścią
   (`blob_hash` = SHA-256 zapisanych bajtów), rozmiar w bajtach i monotoniczny `server_sequence`.
   Nigdy nie widzi plaintextu, nigdy nie liczy diffa, provenance ani merge'a. To jest granica
   z `plan/01` reguła 3 i `plans/001` §2.7 — E2EE jej nie narusza, bo diff/merge/provenance i tak
   już liczy wyłącznie klient (`sync-core`) na plaintekście, lokalnie.
2. **ZERO własnej kryptografii.** Żaden prymityw kryptograficzny nie jest wymyślany ani
   ręcznie implementowany (`plan/01` reguła 6, `CLAUDE.md` reguła 6, `plans/001` §10:
   „No custom cryptographic primitive will be invented."). Używamy wyłącznie sprawdzonej,
   audytowanej biblioteki (kandydaci niżej). Cała „kryptografia" po naszej stronie to składanie
   udokumentowanych wywołań AEAD/KDF/keywrap z tej biblioteki.
3. **Zakazane zależności.** React, Redis, PostgreSQL, message broker, ORM, Kubernetes, własna
   kryptografia — nie wchodzą (`CLAUDE.md`, `plans/001` §5).
4. **Zero cichych nadpisań i zaufanie tożsamości tylko z sesji serwera** pozostają w mocy
   (`plan/01` reguły 4–5). Zepsuty tag AEAD / zła epoka klucza → kwarantanna, nigdy nadpisanie
   lokalnego pliku (`plans/001` §10).
5. **Sekrety nigdy w repo/logach/raportach.** Klucz vaultu, klucze urządzeń, kod odzyskiwania,
   fraza — nigdy w Markdown, commitach, logach aplikacji ani w raporcie subagenta
   (`plan/01` reguła 6). Logi redagują materiał szyfrujący (`specs/003` „Security and privacy
   baseline": „logs ... redacts ... encryption material").

### Wybór biblioteki (jeden audytowany stack, do potwierdzenia w spike'u)

Rekomendacja: **libsodium** przez `libsodium-wrappers-sumo` w kliencie (WASM, działa w Obsidian
desktop na Electron/Chromium; ta sama biblioteka po stronie serwera nie jest potrzebna, bo serwer
nic nie deszyfruje). Alternatywa dopuszczona przez `plans/001` §5/§10: natywne **WebCrypto**
(AES-256-GCM + HKDF), ale WebCrypto nie ma natywnie Argon2id ani `crypto_secretbox`/`crypto_box`,
więc KDF i keywrap i tak wymagałyby libsodium lub `argon2-browser`. Dlatego domyślnie libsodium
dla spójności prymitywów.

> **Uwaga — wiedza może być nieaktualna.** Przed implementacją zweryfikuj aktualne wersje i status
> audytu: `libsodium-wrappers-sumo` (sprawdź najnowszą opublikowaną wersję i changelog),
> zgodność z `minAppVersion` Obsidiana z `plans/001` §5 (≥ 1.11.4), oraz czy WebCrypto na
> docelowych platformach (macOS + Windows, w tym drugi komputer usera z Windows) obsługuje
> wymagane algorytmy bez polyfilli. Nie przyjmuj wersji z tego dokumentu jako obowiązującej.

Dobór konkretnego suite'u (cipher, algorytm klucza urządzenia, kodowanie kodu odzyskiwania)
wymaga dedykowanego spike'u z wektorami testowymi — tak jak nakazuje `plans/001` §10. Ten plan
ustala kształt, nie zamraża liczb bez testów.

### Wyprowadzenie klucza vaultu (KDF)

- Na zaufanym urządzeniu właściciela powstaje **losowy `vault_key`** (32 B z CSPRNG biblioteki),
  NIE wyprowadzany bezpośrednio z hasła. `plans/001` §10: „a random vault key is created on the
  owner's trusted device". To pozwala rotować hasło bez re-szyfrowania całego vaultu.
- Passphrase użytkownika służy do wyprowadzenia **`passphrase_key`** (klucza opakowującego, KEK)
  przez **Argon2id** (libsodium `crypto_pwhash`, `ALG_ARGON2ID13`). Parametry: co najmniej
  `OPSLIMIT_INTERACTIVE`/`MEMLIMIT_INTERACTIVE` jako dolna granica, rekomendacja `MODERATE`;
  dokładne wartości ustala spike pod docelowy sprzęt. `salt` (16 B losowy) jest jawny.
- `vault_key` jest zaszyfrowany („wrapped") pod `passphrase_key` (AEAD, np.
  `crypto_secretbox`/`crypto_aead_xchacha20poly1305`). Wynik = **`wrapped_vault_key`** — może
  bezpiecznie leżeć razem z `salt` i parametrami Argon2id w lokalnej konfiguracji urządzenia
  (NIE w synchronizowanym vaulcie, NIE na serwerze jako plaintext).
- Passphrase NIGDY nie opuszcza urządzenia; `vault_key` NIGDY nie trafia do serwera.

### Co jest szyfrowane, a co serwer nadal legalnie widzi

Struktura `revision envelope` (`plans/001` §7) się nie zmienia — zmienia się tylko zawartość
`opaque_payload`:

- **Szyfrowane (ciphertext AEAD pod `vault_key`, wewnątrz `opaque_payload`):** operacja,
  bieżąca/poprzednia ścieżka pliku, znormalizowany snapshot Markdown (lub tombstone),
  `plaintext_content_hash`, recipe rekonstrukcji, wszelkie wartości pochodne od ścieżki. To jest
  dokładnie „inner schema" z `plans/001` §7 pkt 2, teraz jako authenticated ciphertext.
  Załączniki binarne (F9, już zaimplementowane jako plaintext blob) szyfrowane tym samym
  `vault_key` przed uploadem.
- **Widoczne dla opaque serwera (metadane, jawnie — to NIE jest wyciek do naprawienia, to
  kontrakt):** `blob_hash` (SHA-256 ciphertextu), dokładny rozmiar w bajtach, `server_sequence`,
  czas przyjęcia (`server_receipt`), oraz jawne pola `client_protected_header`: `revision_id`,
  `vault_id`, `file_id` (stabilny, NIE ścieżka), posortowane parent IDs, member/device IDs,
  `payload_format`, wersje semantyczne, cipher suite, `key_epoch`, `nonce`. Header jest AEAD
  associated data (`plans/001` §7, §10) — serwer go widzi, ale nie może podmienić bez zerwania tagu.
- **Świadomie NIE ukrywamy (ograniczenie modelu, opisane uczciwie w threat model):** liczby
  rewizji, rozmiarów, czasów i grafu rodzic-dziecko (DAG). To metadane, których opaque koordynator
  potrzebuje. `file_id` jest nieprzezroczystym identyfikatorem, nie ścieżką — ścieżka jest w
  szyfrowanym payloadzie — więc serwer nie zna nazw plików ani drzewa katalogów, ale zna liczbę
  plików i tempo zmian per `file_id`.

### Wymiana klucza między urządzeniami przy parowaniu (2–3 urządzenia)

Wykorzystujemy istniejący, zweryfikowany głosowo kanał 6-cyfrowego kodu (`specs/002`
„Owner bootstrap"/„Collaborator invitation"; preferencja projektu: kod widoczny tylko na
urządzeniu dołączającym, odczytany na głos, właściciel wpisuje go u siebie — kanał głosowy
utrudnia podszycie). E2EE dokłada do tego transfer klucza:

1. Nowe urządzenie generuje efemeryczną parę kluczy (libsodium `crypto_kx` / `crypto_box`).
2. Przez istniejący flow zaproszenia + zatwierdzenie właściciela po porównaniu frazy
   (`specs/002`; `plans/001` §10: „device enrollment transfers a wrapped vault key only after
   owner approval and phrase comparison"), urządzenie właściciela **opakowuje `vault_key`
   kluczem publicznym nowego urządzenia** (sealed/`crypto_box`) i przekazuje `wrapped_vault_key`
   dla tego urządzenia.
3. Serwer może pośredniczyć w transporcie tej opakowanej wartości (jest ciphertextem — opaque
   serwer jej nie czyta), ale **autoryzacja transferu opiera się na sesji serwera i porównaniu
   frazy przez ludzi**, nie na zaufaniu do serwera co do treści.
4. 6-cyfrowy kod / fraza weryfikacyjna wiąże kanał: potwierdza, że publiczny klucz urządzenia
   dołączającego nie został podmieniony przez pośrednika (obrona przed MITM na parowaniu).
5. Polityka „nowy członek dostaje pełną historię czy tylko checkpoint" jest jawna przy
   zaproszeniu (`plans/001` §10) — dla 2-osobowego pilota domyślnie pełna historia.

### Rotacja klucza i epoki (`key_epoch`)

- Rotacja i usunięcie członka używają jawnych `key_epoch`; serwer egzekwuje vault
  `minimum_write_epoch` z protected header (`plans/001` §10). To jest jedyna „decyzja"
  kryptograficzna, którą opaque serwer podejmuje — czysto liczbowe porównanie epok, bez wglądu
  w treść.
- Rotacja chroni przyszłą treść, ale NIE cofa plaintextu już pobranego przez byłego członka
  (`plans/001` §10) — opisane uczciwie użytkownikowi.

### Interakcja z base-hash i 3-way merge (kluczowe, żeby nic nie zepsuć)

- Kanonikalizacja LF, `plaintext_content_hash`, provenance (offsety UTF-16) i **3-way merge po
  wspólnym przodku** (decyzja MERGE-3WAY z 2026-07-22, `plan/11-BACKLOG.md`) działają WYŁĄCZNIE
  na plaintekście, po stronie klienta, PO deszyfrowaniu. Merge nigdy nie dotyka ciphertextu.
- Odbierający klient przed materializacją weryfikuje: tag AEAD, inner schema, `plaintext_content_hash`,
  recipe, wiązanie z rodzicem oraz vault/file/revision jako AAD (`plans/001` §10). Dopiero potem
  `sync-core` liczy merge na odszyfrowanych snapshotach. Wspólny przodek do 3-way merge to
  odszyfrowana rewizja z historii — jest dostępny lokalnie, bo klient trzyma odszyfrowaną historię.
- Wniosek: E2EE jest przezroczyste dla warstwy merge/provenance. `blob_hash` (serwerowy, po
  ciphertekście) i `plaintext_content_hash` (wewnątrz payloadu) to dwie różne wartości i tak
  pozostaje — E2EE nic tu nie zmienia poza tym, że bajty blobu to teraz ciphertext.

### Odzyskiwanie (recovery) — uczciwie o kompromisach

E2EE oznacza: **utrata klucza = utrata danych, chyba że istnieje sekret odzyskiwania.** Serwer
nie może odzyskać ani odszyfrować treści (`plans/001` §2.6: „The server cannot recover or decrypt
vault contents."). Dlatego:

- **Recovery kit generowany lokalnie, raz, na zaufanym urządzeniu właściciela** (`plans/001`
  §2.6, §10: „a recovery kit can restore the vault key without server knowledge"). Kit zawiera
  drugą, niezależną kopię `wrapped_vault_key` — opakowaną **kluczem odzyskiwania** (recovery key),
  nie hasłem.
- **Recovery key** to wysokoentropijny losowy sekret (np. 256-bit) pokazany użytkownikowi jako
  ludzko-czytelny kod odzyskiwania (kodowanie do ustalenia w spike'u — kandydat: BIP39-style
  słowa lub base32 z sumą kontrolną; ZERO własnej kryptografii, tylko kodowanie).
- Ścieżki odzyskania: (a) **utracona passphrase, urządzenie działa** → użytkownik ustawia nową
  passphrase, `vault_key` re-wrapowany nowym `passphrase_key`; recovery key nie jest potrzebny.
  (b) **utracone wszystkie urządzenia** → nowe urządzenie + recovery key odtwarza `vault_key`
  z recovery kitu, potem ustawia nową passphrase. (c) **utracona passphrase ORAZ recovery key**
  → dane nieodzyskiwalne; to jest jawnie komunikowane przy tworzeniu vaultu, bez fałszywej
  obietnicy.
- **Kompromis escrow — świadomie ODRZUCony jako domyślny:** przechowywanie klucza (lub jego
  udziału) na serwerze/u operatora złamałoby model opaque i twardą regułę `specs/002`.
  Dopuszczalny wyłącznie jako *opt-in*, jawnie udokumentowany, poza domyślną ścieżką, i nie jest
  częścią zakresu Stage 3. Domyślnie: brak escrow, pełna odpowiedzialność użytkownika za recovery
  key, uczciwie zakomunikowana.

---

## Threat model

To jest serce tego planu. Model dokumentuje, co widzi/może **operator serwera, dostawca sieci i
współpracownik**, zgodnie z wymogiem `specs/003` „## Security and privacy baseline"
(„A threat model documents what the server administrator, network provider and collaborators can
observe.") i jest jednym z warunków **Stage 3 — general beta** (`specs/003`: „A security review
and documented threat-model review are complete.").

### 1. Złośliwy / ciekawski operator serwera (honest-but-curious i aktywny)

- **Nie może odczytać treści.** `opaque_payload` to ciphertext AEAD pod `vault_key`, którego
  serwer nigdy nie posiada. Nazwy plików i ścieżki są w środku ciphertextu (`file_id` jest
  nieprzezroczysty).
- **Nie może podmienić treści niezauważenie.** `client_protected_header` (w tym `vault_id`,
  `file_id`, parent IDs, `key_epoch`, `nonce`) jest AAD AEAD — zmiana zrywa tag przy deszyfrowaniu,
  klient kwarantannuje (`plans/001` §10). Podmieniony/uszkodzony ciphertext nigdy nie nadpisuje
  lokalnego pliku (zero cichych nadpisań, `plan/01` reguła 4).
- **Co JEDNAK widzi (jawne metadane, granica modelu):** `blob_hash`, rozmiary bajtowe, tempo i
  liczbę rewizji, DAG rodzic-dziecko per `file_id`, liczbę plików, member/device IDs, czasy.
  Może wnioskować o aktywności (kiedy i jak dużo ktoś pisze), nie o treści. To jest opisane
  uczciwie, nie ukryte (`plan/01` „Uczciwość jako feature").
- **Nie nadaje tożsamości z danych żądania.** `actor_id`/`device_id` pochodzą z sesji serwera
  (`plan/01` reguła 5) — ale to serwer je nadaje; E2EE nie chroni przed serwerem kłamiącym o
  atrybucji. Ograniczenie opisane: atrybucja jest tak wiarygodna jak sesja serwera, nie jest
  kryptograficznie podpisana przez autora w tym zakresie.

### 2. Atakujący w sieci (pasywny podsłuch i aktywny MITM)

- **Transport:** wersjonowane HTTPS (`specs/002`), niezależne od ingressu (Tailscale/Caddy/
  Cloudflare/public). To pierwsza warstwa.
- **Warstwa druga (E2EE):** nawet po złamaniu/terminacji TLS atakujący widzi tylko ciphertext +
  te same metadane co serwer. Bez `vault_key` nie odczyta treści.
- **MITM na parowaniu:** neutralizowany przez porównanie ludzko-czytelnej frazy nad kanałem
  głosowym + 6-cyfrowy kod (`specs/002`, preferencja projektu). Podmiana klucza publicznego
  urządzenia dołączającego zmienia frazę → ludzie wykrywają rozbieżność.
- **Replay:** ciphertext odtworzony pod cudzym headerem jest kwarantannowany (AAD nie pasuje;
  `plans/001` §10). `server_sequence` monotoniczny wykrywa duplikaty na warstwie protokołu.

### 3. Utracone / skradzione urządzenie

- Na urządzeniu leżą: odszyfrowana historia w cache, `wrapped_vault_key` + `salt` + parametry
  Argon2id, oraz refresh token (Obsidian SecretStorage, `specs/002`).
- **Obrona:** `vault_key` na dysku jest tylko w postaci `wrapped_vault_key` — bez passphrase go
  nie odwiniesz (Argon2id spowalnia brute-force). Odszyfrowany cache treści jest jednak dostępny
  dla kogoś z odblokowanym systemem operacyjnym — to ograniczenie at-rest, opisane uczciwie;
  pełne szyfrowanie cache lokalnego jest poza Stage 3 (kandydat na przyszłość).
- **Reakcja:** właściciel odbiera urządzenie (`specs/002`: revoke device) i **rotuje `key_epoch`**;
  serwer podnosi `minimum_write_epoch`, usunięte urządzenie nie może już pisać (`plans/001` §10).
  Rotacja nie cofa plaintextu już pobranego na to urządzenie — komunikowane wprost.

### 4. Utracona passphrase

- Bez passphrase i bez recovery key: **dane nieodzyskiwalne** — wprost z natury E2EE, serwer nie
  pomoże (`plans/001` §2.6). Uczciwie komunikowane przy tworzeniu vaultu.
- Z recovery key: odzyskanie przez recovery kit (patrz „Odzyskiwanie" w `## Spec`).
- To jest świadomy kompromis bezpieczeństwo↔dostępność; escrow odrzucone jako domyślne, bo
  łamie model opaque.

### 5. Atak downgrade

- **Downgrade szyfrowania → plaintext:** vault policy i discovery response deklarują wymagany
  `payload_format_version` i minimalny suite/epokę szyfrowania jako **wymagania, nie podpowiedzi**
  (`plans/001` §7). Klient, który nie umie spełnić wymaganej semantyki E2EE, **fail-closed** przed
  uploadem i przed lokalną aplikacją; nieznane mutujące zdarzenie zostaje w kwarantannie, nigdy nie
  jest „po cichu" potraktowane jako plaintext.
- **Downgrade epoki klucza:** serwer egzekwuje `minimum_write_epoch` — rewizja pod starą epoką po
  rotacji jest odrzucona (`plans/001` §10).
- **Downgrade wersji protokołu:** niekompatybilny klient jest odrzucany przed uploadem/aplikacją z
  czytelną instrukcją aktualizacji (`specs/003` „Versioning and compatibility").
- **Kluczowe:** disposable plaintext vault NIE jest nigdy podnoszony in-place do E2EE
  (`plans/001` §10) — pierwszy prawdziwy vault jest E2EE od pierwszej rewizji, więc nie ma stanu
  „mieszanego", który dałoby się zdowngrade'ować do plaintextu.

### 6. Wyciek metadanych (metadata leakage)

- **Co przecieka (świadomie):** rozmiary bajtowe (mogą korelować z długością notatek), tempo i
  czasy zmian, liczba plików, DAG, member/device IDs. Operator i sieć to widzą.
- **Czego NIE ma:** treści, nazw plików, ścieżek, drzewa katalogów (`file_id` nieprzezroczysty).
- **Możliwe wzmocnienia (poza Stage 3, do rozważenia):** padding rozmiaru blobów do koszyków,
  ograniczanie ujawniania czasów. Nie są wymagane do bramki Stage 3; wymieniamy je uczciwie jako
  znane ograniczenie, nie jako obietnicę.
- **Redakcja logów:** logi aplikacji i diagnostyka redagują materiał szyfrujący i sekrety,
  weryfikowane testami automatycznymi (`specs/003` „Security and privacy baseline"; `plan/01`
  reguła 6).

---

## Acceptance tests

Testy funkcjonalne i weryfikowalne (TDD red-green-refactor, `plan/01` reguła 2). Każdy odpowiada
za konkretną własność bramki **Stage 3 — general beta**.

1. **Round-trip szyfrowania (`sync-core`, unit).** Dla losowego snapshotu Markdown: encrypt →
   decrypt → identyczny plaintext; `plaintext_content_hash` zgodny; recipe rekonstruuje treść.
   Odpowiada `plans/001` §10 „encrypt/decrypt/schema/recipe round trip before upload".

2. **Serwer nigdy nie widzi plaintextu (integration, 2 klienty + serwer).** Klient A zapisuje
   znaną frazę-sygnał (np. `CANARY-<uuid>`). Test przeszukuje bloby serwera, SQLite i logi
   aplikacji: fraza NIE występuje jako plaintext w żadnym z nich. Odpowiada `specs/003` acceptance:
   „A diagnostic report contains no ... note content or encryption key."

3. **Odrzucenie manipulacji AEAD (unit + integration).** Przewrócenie 1 bitu w ciphertekście,
   podmiana pola `client_protected_header` (np. `file_id`), oraz replay ciphertextu pod innym
   headerem → w każdym przypadku deszyfrowanie/weryfikacja się nie udaje, rewizja trafia do
   kwarantanny, lokalny plik pozostaje niezmieniony. Odpowiada `plans/001` §10 (quarantine) i
   `plan/01` reguła 4 (zero cichych nadpisań).

4. **Multi-device recovery test — jawny wymóg Stage 3 (e2e).** Vault E2EE utworzony na urządzeniu
   właściciela; drugie urządzenie dołącza przez zaproszenie + porównanie frazy; oba synchronizują
   tę samą treść po deszyfrowaniu. Następnie: (a) drugie urządzenie odtwarza `vault_key` po
   sparowaniu, (b) trzecie urządzenie dołącza analogicznie. Test dowodzi:
   „end-to-end encryption ... passes multi-device recovery tests" (`specs/003` Stage 3).

5. **Odzyskiwanie z recovery kit bez wiedzy serwera (e2e).** Symulacja utraty wszystkich urządzeń:
   świeże urządzenie + recovery key odtwarza `vault_key` z recovery kitu i odszyfrowuje pełną
   historię. Serwer NIE uczestniczy w odzyskaniu klucza. Odpowiada `plans/001` §2.6/§10.

6. **Utrata bez recovery key = jawna, kontrolowana porażka (unit/e2e).** Bez passphrase i bez
   recovery key odzyskanie zawodzi z jednoznacznym, ludzko-czytelnym komunikatem (bez sugestii, że
   serwer pomoże). Dowodzi uczciwości modelu, nie „magicznego" odzysku.

7. **Odporność na downgrade (integration).** Klient zgłaszający `payload_format_version` niższy niż
   wymagany przez vault policy (próba plaintext/starej epoki) jest odrzucony **przed** jakąkolwiek
   zmianą treści lokalnej lub zdalnej; zdarzenie zostaje durably pending/quarantined, nie „applied".
   Odpowiada `specs/003` acceptance „Plugin/server incompatibility is detected before any local or
   remote content is changed." oraz `plans/001` §7/§10.

8. **Rotacja epoki wyklucza usuniętego członka (integration).** Po rotacji `key_epoch` i podniesieniu
   `minimum_write_epoch`: rewizja pod starą epoką jest odrzucona przez serwer; usunięte urządzenie
   nie uzyskuje nowej epoki ani nie zapisuje. Odpowiada `plans/001` §10.

9. **Merge/provenance działa na deszyfrowanym plaintekście (integration, styk z MERGE-3WAY).**
   Dwa rozbieżne edyty tego samego pliku w vaulcie E2EE: 3-way merge po wspólnym przodku daje ten
   sam wynik co w pilotażu plaintext; nienakładające się huki mergują się, genuinnie nakładające
   tworzą conflict copy w `Havemind Conflicts/`. Dowodzi, że E2EE jest przezroczyste dla warstwy
   merge.

10. **Załączniki binarne szyfrowane (e2e, styk z F9).** Załącznik (np. PNG/PDF z allowlisty F9)
    synchronizuje się jako ciphertext; odbiorca po deszyfrowaniu ma bajtowo identyczny plik;
    bloby na serwerze nie zawierają plaintextu pliku. Odpowiada `specs/003` Stage 3
    („note contents and attachments").

11. **Backup zawiera ciphertext + kompletne metadane (integration).** Backup serwera odtwarza
    users, metadane vaultu, rewizje i **zaszyfrowaną** treść na czystej maszynie; nie zawiera
    `vault_key`. Odpowiada `plans/001` §10 („backups contain ciphertext but ... preserve all
    required metadata and blobs") i `specs/003` acceptance („restores ... encrypted content on a
    clean machine").

12. **Redakcja sekretów w logach/diagnostyce (unit).** `havemind doctor` i logi aplikacji nie
    zawierają `vault_key`, `wrapped_vault_key`, recovery key, passphrase, tokenów ani plaintextu —
    weryfikowane automatycznie. Odpowiada `specs/003` „Security and privacy baseline".

13. **Wektory testowe biblioteki (unit).** Znane test vectors dla Argon2id, AEAD i keywrap z
    wybranej biblioteki przechodzą — dowód, że używamy prymitywów poprawnie i nie wprowadziliśmy
    własnej kryptografii. Odpowiada `plans/001` §10 („test vectors"; „No custom cryptographic
    primitive will be invented.").

---

## Rollout/rollback

### Kolejność wdrożenia (zgodna z fazowaniem `specs/003` i `plans/001` §11)

E2EE implementujemy **po** tym, jak pilotaż plaintext udowodni semantykę synchronizacji
(`plans/001` §10, §11) i po zamknięciu bieżących milestone'ów 1.0 pilota (7-dniowy pilotaż +
bramka T033). Krok po kroku:

1. **Spike kryptograficzny (bez produkcyjnego użycia).** Wybór i weryfikacja biblioteki (wersje,
   status audytu — patrz nota „wiedza może być nieaktualna"), dobór cipher suite, algorytmu klucza
   urządzenia, parametrów Argon2id i kodowania recovery key. Wynik: wektory testowe + decyzja
   zapisana w `DECISIONS.md`. To realizuje „dedicated threat-model spike and test vectors"
   (`plans/001` §10).
2. **`sync-core`: warstwa payloadu.** Implementacja encrypt/decrypt/verify wokół istniejącego
   inner schema, z headerem jako AAD. Merge/provenance nietknięte — działają na deszyfrowanym
   plaintekście. Testy 1, 3, 9, 13.
3. **Zarządzanie kluczami i parowanie.** Argon2id wrap `vault_key`, transfer przy enrollmencie
   przez istniejący kanał frazy/6-cyfr, `key_epoch` + `minimum_write_epoch`. Testy 4, 8.
4. **Recovery kit.** Generacja lokalna, recovery key, ścieżki (a)/(b)/(c). Testy 5, 6, 11.
5. **Załączniki + backup + diagnostyka.** Testy 10, 11, 12.
6. **Przegląd bezpieczeństwa i przegląd threat-modelu** (wymóg Stage 3) — dopiero po zielonych
   testach 1–13.

**Pierwszy prawdziwy vault jest tworzony jako E2EE od pierwszej rewizji.** Disposable plaintext
pilot NIE jest migrowany in-place (`plans/001` §10). To upraszcza rollback: nie ma konwersji
danych do cofnięcia.

### Bramki wymagające pytania usera (`plan/01` reguła 9) — NIE robić bez zgody

- **Zmiana zatwierdzonego modelu szyfrowania/zaufania** — jawnie wymaga pytania usera
  (`plan/01` reguła 9). Ten plan to szkic; jego zatwierdzenie i każda późniejsza zmiana suite'u to
  decyzja usera.
- **Podłączenie prawdziwego (nie-jednorazowego) vaultu** — zawsze pytanie usera (`plan/01`
  reguła 9). Pierwszy real vault E2EE = ta bramka.
- **Włączenie Tailscale Funnel / publiczne wystawienie, operacje `sudo` na `sapserver`,
  nieodwracalne operacje na backupach, `git push`/PR** — bez zmian, zawsze pytanie usera.
- **Escrow klucza** (gdyby kiedyś rozważany) — zmiana modelu zaufania, wymaga jawnej zgody i
  osobnego przeglądu; poza zakresem Stage 3.

### Rollback

- **Podczas developmentu (przed pierwszym real vaultem E2EE):** feature działa tylko na
  disposable vaultach; rollback = wyłączenie ścieżki E2EE / rewert commitów. Zero danych
  produkcyjnych do migracji, bo plaintext pilot nigdy nie był podnoszony do E2EE.
- **Po utworzeniu real vaultu E2EE:** downgrade do plaintextu jest **niedozwolony** — złamałby
  twardy warunek `specs/002`. „Rollback" oznacza wyłącznie: przywrócenie poprzedniej wersji
  serwera/obrazu z pre-upgrade backupem (`specs/003` „For a self-hoster": backup + matching
  container image), gdzie backup i tak zawiera ciphertext. Migracje w dół bazy nie są obiecywane
  (`specs/003`). Bloby są content-addressed i niemutowalne, więc przywrócenie obrazu nie niszczy
  historii rewizji.
- **Rotacja jako „miękki rollback" kompromitacji:** jeśli urządzenie/członek skompromitowany,
  właściwą reakcją nie jest downgrade, lecz rotacja `key_epoch` + revoke device (Test 8) — z
  uczciwym zastrzeżeniem, że plaintext już pobrany nie jest cofalny.

### Warunki uznania bramki za spełnioną

Stage 3 — general beta w części E2EE jest domknięty, gdy: testy akceptacyjne 1–13 są zielone
(≥ 80% coverage, `plans/001` §5), spike zapisał wybór biblioteki i wektory w `DECISIONS.md`,
przegląd bezpieczeństwa i przegląd threat-modelu są zamknięte, a dokumentacja publiczna stwierdza
wprost, kto może odczytać treść notatek dla tego wydania (`specs/003` acceptance: „Public release
documentation states exactly which party can read note contents") — odpowiedź: wyłącznie
posiadacze `vault_key`, nigdy operator serwera.
