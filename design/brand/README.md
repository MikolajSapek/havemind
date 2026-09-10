# Brand assets

Source artwork. Nothing in this repository's own Markdown links most of these
files, which is expected: they are consumed by the **distribution** repository
(`MikolajSapek/obsidian-havemind`), which keeps its own copies under `assets/`
because GitHub serves a README's images from the repository it lives in.

| File | Used by |
|---|---|
| `havemind-banner-white.png` | the README in this repository |
| `havemind-banner.png`, `havemind-banner.svg` | the dark-ground variant, kept as the editable source |
| `havemind-mark.png`, `havemind-mark.svg` | the mark alone, for favicons and small placements |
| `havemind-hero.gif` | the hero on both READMEs: a note typed on a laptop arriving on a phone |
| `havemind-phone.gif` | the same recording, phone only, for placements too narrow for the pair |

`havemind-devices.png` and its SVG were removed: a drawn mockup of the two
devices, superseded by `havemind-hero.gif`, which shows the same idea with real
captures and real motion.

## Regenerating the hero

`scripts/frame-gif.py` composites screen recordings into device bezels. It
finds each screen by scanning the bezel's alpha channel, so any mockup with
blank screens works:

```bash
python3 scripts/frame-gif.py mockup.png --inspect -o probe.gif   # check first
python3 scripts/frame-gif.py mockup.png \
  --laptop desktop.mov --phone phone.mov \
  -o design/brand/havemind-hero.gif --width 1200 --fps 12
```

Apple's own device bezels are **not** committed here. Their licence covers
making mock-ups of software that runs on Apple systems, not redistributing the
bezels themselves. Renders are fine; the source PNGs are not.
