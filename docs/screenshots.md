# Screenshots and the hero animation

What the two READMEs show, how it was captured, and the rules a replacement
has to follow. This replaces three planning documents written while the work
was still ahead: the hero GIF and the stills are shot and shipped.

## What ships today

| Asset | Where |
|---|---|
| `design/brand/havemind-hero.gif` | top of both READMEs |
| `design/brand/havemind-phone.gif` | phone-only cut, for narrow placements |
| `docs/images/01-status-framed.png` | catalogue README, Status |
| `docs/images/03-people-framed.png` | catalogue README, People |
| `docs/images/04-mobile-framed.png` | catalogue README, mobile |

The unframed originals sit beside them in `docs/images/`.

## Why the hero is a GIF

Sync is a behaviour. A still frame can show the pane, but not the one-second
delay that is the whole product, so the hero is a loop: a note typed on a
laptop appearing on a phone about a second later. LiveSync, the closest
comparable plugin, leads with a GIF for the same reason.

Keep it under 5 MB. The current file is 0.3 MB at 1400x903, 12 fps, 15.6 s.

## How the hero was recorded

The plugin waits `MODIFY_SETTLE_MS = 1500` for a file to go quiet before
sending it, and **resets that window on every further write to the same path**
(`modify-debounce.ts`). Typing character by character therefore syncs once, at
the end, and the recording shows one lump instead of a rhythm.

What works: **one write per line, then a pause past the window.** Four short
lines at three-second intervals give four separate arrivals in about eleven
seconds:

```
One vault.  /  Every device.  /  Your server.  /  About a second.
```

How the 1.7.1 hero was shot, so the timing on screen is the real one:

1. The Obsidian window out of full screen, sized to the MacBook screen's
   1.549 ratio, with the iPhone Mirroring window beside it, both on one
   display. The note is in reading view, so no `#` shows on the cursor's line,
   and the pane is on Status, where the core spins while it sends and turns
   green when done.
2. One `screencapture -v -V 18` of the whole display, while a shell appends
   the four lines to the note on disk three seconds apart. One recording means
   the laptop and the phone share one clock.
3. Crop the laptop and the phone (below the iOS status bar) into frames with
   ffmpeg, composite them with `scripts/compose-hero.py`, and build the GIF
   with ffmpeg's `palettegen`. The script blacks out the Mirroring window's
   rounder bottom corners and masks the screen to the bezel's radius.

`scripts/frame-gif.py` composites into any mock-up with white screens and is
still the quicker path when the two recordings come from separate devices.

## Rules for any capture

1. **Throwaway vault, invented content.** Note titles, member names and server
   addresses become public, and the frame also lands in the Obsidian catalogue
   listing. Never a real tailnet hostname.
2. **Dark theme, default Obsidian**, matching the brand assets.
3. **Zoom to ~120%** before capturing. Default type is unreadable at GitHub's
   column width.
4. **Crop the iOS status bar**, never paint over it: a painted bar renders as
   a lighter block against Obsidian's true black, and the red recording
   indicator must not ship.
5. **Blur or fake any 6-digit code.** It is a credential.
6. **Relative paths in Markdown.** The catalogue rewrites relative image links
   against the repository and cannot rewrite anything else.
7. **Alt text on every image.**

## Still to capture

- **A conflict.** "Zero silent overwrites" is the strongest differentiator
  against every other sync tool, and nothing shows it. To make one: put the
  phone in airplane mode, edit the same line on both devices differently,
  reconnect. A conflict copy lands in `Havemind Conflicts/` and the pane shows
  an alarm block above the tabs.
- **The onboarding row**: invitation composer, the 6-digit code on the joining
  device, and the owner's approval row with its attempt counter. Three
  captures, best shown as one row.
- **Activity, re-shot.** The current capture reads "Remote edit" instead of
  author names, the three-person attribution defect being fixed.
