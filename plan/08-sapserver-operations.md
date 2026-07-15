# 08 — Sapserver operations

Faza równoległa do F7/F8, ale z osobnym blockerem: **backup musi być gotowy PRZED T032**,
nie równolegle z nim (patrz `01-zasady-i-slownik.md` reguła 8-9). Dane liczbowe poniżej pochodzą
z `Wiedza/Sapserver - dostęp i konfiguracja.md` (Mikolaj Private) — zweryfikuj je ponownie
(`ssh sapserver` + polecenia z sekcji „Przydatne polecenia" tej notatki) przed rozpoczęciem tej
fazy, bo notatka mogła się zmienić od ostatniej aktualizacji.

## Agent budujący jest połączony z serwerem i wolno mu go modyfikować

- Połączenie zweryfikowane: `ssh sapserver` (Tailscale `100.112.246.26`) z MacBooka; alias
  `sapserver-lan` (`192.168.254.107`) jako awaryjny w sieci domowej.
- Agent (Claude Code / Codex, wg tego samego modelu zaufania co „Dostęp Codexa przez CLI" w
  notatce Sapservera) MOŻE samodzielnie: łączyć się przez SSH, diagnozować stan usług, tworzyć
  pliki Compose w `/srv/compose/havemind/`, uruchamiać `docker compose up/down` (przez `sudo`,
  świadomie, w ramach jednej sesji), konfigurować Tailscale Serve dla usługi Havemind, edytować
  pliki w `/srv/appdata/havemind` zgodnie z konwencją service-per-directory.
- Agent NIE MOŻE bez pytania usera: wykonywać kroków wymagających hasła `sudo` (nie zna hasła —
  musi je poprosić usera o wpisanie interaktywnie albo wykonać krok samemu), włączać Tailscale
  Funnel, dodawać siebie/użytkownika `mikolaj` do grupy `docker`, kasować backupy lub wykonywać
  `restic forget --prune` bez wcześniejszego `restic check`, zmieniać reguły UFW poza tym co jest
  jawnie w issue, wystawiać jakikolwiek port na `0.0.0.0`.
- To NIE jest hipotetyczny target wdrożenia z listy „do wyboru" — to jedyny serwer, na którym
  Havemind faktycznie zostanie uruchomiony w Fazie 7.

## Stan sprzętu i ograniczenia (liczby, nie przymiotniki)

- CPU i5-8600K/6 rdzeni, RAM 16 GB (praktycznie 15,9 GB), GPU GTX 1070 nieużywana na tym etapie.
- Dysk systemowy: 120 GB NVMe, partycja systemowa ~109 GB, ~96 GB wolne przy ostatnim sprawdzeniu.
  Budżet: kontener Havemind + SQLite + blob store musi mieścić się komfortowo w tej przestrzeni;
  jeśli projekcja rozmiaru danych pilotażu przekroczy ~20 GB, zatrzymaj się i zapytaj usera przed
  kontynuacją (dysk jest współdzielony z systemem i innymi eksperymentami).
- Sieć: wyłącznie Wi-Fi (`wlp4s0`) obecnie — plan Etapu 4 z notatki (Ethernet) NIE jest
  prerekwizytem tej fazy, ale zanotuj w `DECISIONS.md` jeśli stabilność Wi-Fi wpłynie na wynik
  siedmiodniowego pilotażu.

## Issues tej fazy (numeracja w `11-BACKLOG.md`, prefix `SRV-`)

| Issue | Opis | Blokująca dla |
|---|---|---|
| SRV-01 | Aktualizacja Tailscale na serwerze do najnowszej wersji | F8 (pilotaż) |
| SRV-02 | Wybór miejsca backupu (USB / NAS / Backblaze B2) — decyzja usera | SRV-03 |
| SRV-03 | Wdrożenie Restic: repo szyfrowane, retencja 7 dziennych/4 tygodniowych/6 miesięcznych | T032 (twardy blocker) |
| SRV-04 | Test przywracania pojedynczego pliku z Restic | SRV-03 → T032 |
| SRV-05 | Test przywracania całej usługi (Havemind) z Restic na czystą instancję | T032 |
| SRV-06 | Testowa strona Docker na `127.0.0.1:8080` + Tailscale Serve (dry-run przed realną usługą) | F7-02 |
| SRV-07 | Potwierdzenie/ustawienie autostartu po awarii zasilania w BIOS | F8 (pilotaż 7-dniowy nie przetrwa przerwy prądu bez tego) |

## Anty-spec (S5)

- Zakaz instalowania Kubernetes/k3s, Portainera, Cockpit, Nginx Proxy Manager, Watchtowera,
  globalnej bazy PostgreSQL/MySQL „na zapas", Samby/NFS bez konkretnej potrzeby, Fail2ban (SSH
  już ograniczone kluczem i Tailscale), sterownika NVIDIA/narzędzi LLM przed etapem AI — zgodnie
  z sekcją „Czego obecnie nie instalujemy" notatki Sapservera.
- Zakaz jakiegokolwiek publicznego portu poza krótkim, jawnie zatwierdzonym demo przez Tailscale
  Funnel (Etap 2 hostowania, osobna decyzja usera, nigdy dane prywatne).
- Zakaz dodawania użytkownika `mikolaj` do grupy `docker`.
