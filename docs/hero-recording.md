# Hero recording, the shot list

One 10-second loop for the top of the README: a note typed on the laptop
appearing on the phone about a second later. That delay is the whole product,
and no still image can carry it.

Everything below happens in a note called **Untitled** in a throwaway vault.

## Before recording

1. **Throwaway vault only.** The frame lands in the Obsidian catalogue listing,
   so every visible note title, contact name and server URL becomes public.
   Never a real tailnet hostname.
2. **Dark theme, default Obsidian,** on both devices. Matches the brand assets.
3. **Havemind pane open** on both: docked right on the laptop, full screen on
   the phone.
4. Status reads **Synced** on both before you start rolling.
5. Silence notifications on both devices.

## The sequence

| Time | Laptop | Phone |
|---|---|---|
| 0.0-1.0s | `Untitled` open, empty, cursor blinking | same note, empty |
| 1.0-6.0s | type **Havemind**, roughly one letter per 0.5s | still empty |
| 6.0-6.3s | done, cursor blinking after the word | pane flips to `Syncing` |
| 6.3-7.3s | unchanged | **the word appears, letter-complete** |
| 7.3-8.0s | unchanged | pane settles on `Synced` |
| 8.0-10.0s | both hold still, so the loop restarts cleanly | |

The status labels are exactly what the plugin renders: `Syncing`, then
`Synced` (`src/runtime/status.ts`).

## Recording

**Laptop.** QuickTime, File > New Screen Recording, or `Shift-Cmd-5`. Record the
Obsidian window only, not the whole desktop. Aim for the 3260x2105 shape of the
MacBook cutout; anything wider gets centre-cropped.

**Phone.** Settings > Control Centre > add Screen Recording, then start it from
Control Centre. Record the full screen.

Record both at once and clap once at the start, on camera, in shot. The clap
gives the two files a shared frame to align on. Without it, aligning by eye
costs more time than the clap saves.

## After recording

Both files go to `frame-gif.py`, which composites them into the device frames:

```bash
python3 scripts/frame-gif.py design/frames/apple/scene.png \
  --laptop laptop.mov --phone phone.mov \
  -o design/brand/havemind-hero.gif \
  --width 1200 --fps 12
```

Trim both clips to the same 10 seconds first, with the phone's copy starting
about 1.2s later than the laptop's, so the delay reads as sync rather than as
lag. Keep the GIF under 5 MB; `--width 1000` or `--fps 10` gets there if the
first render is heavy.

## What not to do

- **No title cards, no captions, no music.** The loop plays silently in a README
  and has two seconds to land.
- **Do not type on the phone.** The moment the phone types anything, the shot
  stops being about sync and becomes a typing animation.
- **Do not speed up the typing.** Faster than one letter per 0.4s and the
  one-second sync delay stops being legible.
