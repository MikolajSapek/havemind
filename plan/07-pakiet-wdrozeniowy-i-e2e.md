# 07 — Hardened Compose i e2e fault harness

Zadania źródłowe: T030, T031. Ten pakiet wdrożeniowy jest budowany DLA `sapserver` konkretnie —
patrz `08-sapserver-operations.md` dla realnych ograniczeń maszyny docelowej.

## Kontrakt Compose (twarde wartości, nie przymiotniki)

```yaml
# szkic wymagań, nie gotowy plik — issue F7-02 pisze rzeczywisty compose.yaml
services:
  havemind-server:
    user: "1000:1000"          # non-root, brak privileged
    read_only: true             # gdzie kompatybilne z runtime Node
    cap_drop: ["ALL"]
    security_opt: ["no-new-privileges:true"]
    ports:
      - "127.0.0.1:8787:8787"    # NIGDY 0.0.0.0
    volumes:
      - /srv/appdata/havemind:/data
    secrets:
      - havemind_db_key          # plik w /srv/secrets, nigdy env inline
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "healthcheck.js"]
      interval: 30s
      timeout: 5s
      retries: 3
    tmpfs:
      - /tmp
    init: true
```

Budżety: obraz przypięty do konkretnego tagu + digestu (nie `latest`); log driver `local`,
`max-size: 10m` (spójne z istniejącym `/etc/docker/daemon.json` na `sapserver`).

## Tabela zdarzenie → reakcja (fault harness, T031)

| Zdarzenie wstrzyknięte | Oczekiwana reakcja |
|---|---|
| Restart serwera w trakcie push | brak duplikacji rewizji po ponownym starcie (idempotencja) |
| Restart klienta w trakcie lokalnego apply | plik materializuje się poprawnie po restarcie, brak połowicznego stanu |
| Partycja sieci 2 klienty offline równocześnie | po powrocie: konwergencja bez utraty żadnej zaakceptowanej rewizji |
| Duplicate delivery (retry sieciowy) | serwer zwraca oryginalny wynik, brak drugiej rewizji |
| Restore z backupu na czystą instancję | nowa epoka wymusza pojednanie u wszystkich klientów |
| Konflikt tej samej linii u obu klientów | oba heady zachowane, wpis w `Havemind Conflicts/`, żadna cicha utrata |

## Anty-spec (S5)

- Zakaz `ports: ["8080:80"]` bez jawnego `127.0.0.1:` prefixu — to jest błąd bezpieczeństwa,
  nie styl.
- Zakaz obrazu bez pinned digestu w konfiguracji przeznaczonej do uruchomienia na `sapserver`.
- Zakaz Watchtower / automatycznych aktualizacji kontenera (zgodnie z notatką Sapservera:
  „aktualizacje ręczne i kontrolowane").

## Issues → BACKLOG mapping

- F7-02 — hardened Compose (T030)
- F8-01 — e2e fault harness (T031, przed bramką pilotażu)
