# Screenshots

Captures of the plugin running in a throwaway vault, kept here as the source of
truth. The **distribution** repository (`MikolajSapek/obsidian-havemind`) holds
its own copies under `assets/`, because GitHub serves a README's images from
the repository that README lives in.

| File | What it shows |
|---|---|
| `01-status.png` | Status tab, connected and synced |
| `02-activity.png` | Activity feed |
| `03-people.png` | People tab: owner and two connected editors |
| `04-mobile.png` | The pane full screen on an iPhone |
| `*-framed.png` | The same captures composited into Apple device bezels; these are what the catalogue README uses |

## Rules for a new capture

1. **Throwaway vault, invented content.** Note titles, member names and server
   addresses become public. Never a real tailnet hostname.
2. **Dark theme, default Obsidian**, to match the brand assets.
3. **Crop the iOS status bar** on a phone capture rather than painting over it:
   a painted bar renders as a lighter block against Obsidian's true black, and
   the recording indicator must not ship.
4. **Relative paths in Markdown.** The Obsidian catalogue rewrites relative
   image links against the repository; it cannot rewrite anything else.
5. **Alt text on every image.**

`02-activity.png` is currently held back from the catalogue README: it renders
"Remote edit" instead of author names, the three-person attribution defect being
fixed. Re-shoot it once names appear.
