# README screenshots, the nine still to make

The hero is done: `design/brand/havemind-hero.gif` sits under the banner and
shows a note typed on a MacBook arriving on an iPhone about a second later.
Nine stills remain. Every one of them illustrates a claim the README currently
makes in prose alone.

Grounded in three sources, in order of authority:

1. **Obsidian's submission requirements.** *"An excerpt is shown on your
   entry's public listing page, with relative links and images (for example
   `./images/screenshot.png`) automatically rewritten to resolve against your
   repository."*
   ([Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin))
   The images near the top are the plugin's shopfront in the catalogue, seen by
   people who never open GitHub. Relative paths are required for that rewriting.
2. **What the competing plugins ship** (measured): LiveSync 12.3k stars leads
   with a GIF, Obsidian Git 12.0k pairs one PNG with each named view, Dataview
   9.3k does the same. Obsidian Git's pattern is the one to copy for the stills.
3. **Published README research**: a visitor decides in two to three seconds.

## The nine

### 1. The pane, connected and synced (desktop)
Status tab, green dot, "Last sync", the roster with two or three people.
Crop to the pane plus enough editor to establish it is Obsidian, not a full
window; the catalogue excerpt crops narrow.
Proves: the product exists and looks finished.
Source: `src/ui/screens/status-indicator.ts`, `people-tab.ts`.

### 2. The pane on a phone
Full screen, bottom tab bar, one-handed. A plain device screenshot; the hero
already supplies bezels.
Proves: "desktop and mobile", now claimed in the README, the manifest and the
catalogue description, with nothing yet showing it.
Blocked on: MOB-02, the phone smoke test. Capture during that pass.

### 3. Conflict resolution
The conflict modal, or a `Havemind Conflicts/` entry with both versions side
by side.
Proves: "zero silent overwrites", the strongest differentiator against every
other sync tool and the claim a cautious reader most wants proven before
trusting a vault to it.
Source: `src/ui/conflict-modal.ts`, `conflict-section.ts`.

### 4. Activity panel with author colours
Several authors, distinct colours, one-click restore visible.
Proves: "authorship everywhere".
Source: `src/ui/activity-section.ts`.

### 5. Author overlay in the editor
Coloured attribution over the note text itself.
Proves: the same claim as 4, but in the place a reader actually works. No
competitor shows anything like it.

### 6. Invitation composer
The owner creating an invitation.
Source: `src/ui/screens/invite-composer.ts`.

### 7. The 6-digit code on the joining device
**Blur or fake the code.** A real one is a credential.
Source: `src/ui/screens/guest-waiting.ts`.

### 8. Owner approving
The approval row with code entry and its 3-attempt counter.
Proves, with 6 and 7: onboarding is human-verified, not a pasted secret.
Best presented as one row of three.
Source: `src/ui/screens/pending-approval-row.ts`.

### 9. Architecture diagram
Not a screenshot. Two devices, one self-hosted server, arrows showing nothing
else is contacted. Belongs under "Architecture", where prose carries the whole
load today. Mermaid renders natively on GitHub, so it costs nothing to
maintain and stays diffable.

## Order to shoot them

1, 3, 4 first: all desktop, all capturable in one sitting, and they cover the
three claims a reader weighs before installing.
Then 6, 7, 8 as one onboarding row.
Then 5 and 9.
2 waits for MOB-02.

## Rules for every capture

1. **Relative paths, in-repo.** `./design/brand/x.png`, never an external URL.
   The catalogue rewrites relative paths and nothing else. LiveSync's
   `user-images.githubusercontent.com` GIF is the liability to avoid.
2. **Throwaway vault, invented content.** Note titles, names and server URLs
   go public. Never a real tailnet hostname.
3. **Dark theme, default Obsidian.** Matches the brand assets and the hero.
4. **2x resolution, downscaled.** Crisp on retina.
5. **Crop to the subject.** Full-window captures are unreadable at GitHub's
   column width and worse in the catalogue excerpt.
6. **Alt text on all of them.** The README already claims accessibility care.
7. **PNG for stills.** The hero is the only animation.

## Structural fixes, no screenshot needed

- **No badges.** Research converges on four functional ones: version, licence,
  build status, catalogue link. All three benchmark plugins carry them.
- **No install section.** There is a self-hosting guide, but nothing saying
  "search Havemind in Community plugins", which is the first thing a reader
  wants and the README never answers.
- **No table of contents,** at 187 lines and nine sections.
- **Licence not stated in the README body.** The repository carries Apache 2.0
  in `LICENSE`, as Obsidian requires, but the README mentions licensing zero
  times.
