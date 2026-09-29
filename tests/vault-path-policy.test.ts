/**
 * Which vault paths sync, pinned for every layer that answers the question.
 *
 * Two places decide it: the plugin's `classifyVaultPath` (does this local file
 * sync, and as text or as a binary attachment) and the protocol's
 * `canonicalizeVaultPath` (can this path travel on the wire at all, checked
 * again by the schema and on every decode). They were written apart and have
 * disagreed before: a backslash path and a case variant of the reserved
 * folder were each "eligible" locally and then threw at envelope build, which
 * stopped the push cycle. Only a table that names both verdicts for the same
 * path keeps them from drifting, so this one is the contract: a change to
 * either policy has to change a row here on purpose.
 *
 * Each row is [path, what the plugin decides, what the protocol says about the
 * RAW path]. The plugin normalises backslashes and Unicode form before it
 * decides, the protocol refuses a backslash outright, so the two columns are
 * allowed to differ on those rows and the header of each group says why.
 */

import { canonicalizeVaultPath } from '@havemind/protocol';
import { describe, expect, it } from 'vitest';

import {
  classifyVaultPath,
  normalizeWirePath,
} from '../apps/obsidian-plugin/src/obsidian/vault-adapter';

type Kind = 'markdown' | 'binary' | null;
type Verdict = 'ok' | 'empty' | 'relative' | 'control' | 'segment' | 'reserved';
type Row = readonly [path: string, plugin: Kind, protocol: Verdict];

const md = 'markdown';
const bin = 'binary';

/** Substring of the message `canonicalizeVaultPath` throws for each refusal. */
const REFUSAL: Readonly<Record<Exclude<Verdict, 'ok'>, string>> = {
  control: 'must not contain control characters',
  empty: 'must not be empty',
  relative: 'must be relative and use forward slashes',
  reserved: 'reserved Havemind root',
  segment: 'empty or traversal segment',
};

/** The attachment extensions that sync as binary. Spelled out, not imported. */
const BINARY_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf'];

/** Types Obsidian users keep in a vault that Havemind does not carry. */
const EXCLUDED_EXTENSIONS = [
  'avif', 'bmp', 'canvas', 'base', 'csv', 'css', 'dmg', 'docx', 'epub',
  'excalidraw', 'exe', 'heic', 'html', 'ico', 'js', 'json', 'mov', 'mp3',
  'mp4', 'pptx', 'psd', 'sqlite', 'tiff', 'ttf', 'txt', 'wasm', 'wav',
  'woff2', 'xlsx', 'zip',
];

const NOTES: readonly Row[] = [
  ['note.md', md, 'ok'],
  ['Notes/Plan.md', md, 'ok'],
  ['a/b/c/d/e.md', md, 'ok'],
  ['Notes/UPPER.MD', md, 'ok'],
  ['Notes/Mixed.Md', md, 'ok'],
  ['Notes/a.b.c.md', md, 'ok'],
  ['Notes/x..md', md, 'ok'],
  ['Notes/with space.md', md, 'ok'],
  ['Notes/ leading space.md', md, 'ok'],
  ['Notes/trailing space .md', md, 'ok'],
  ['Notes/日本語のノート.md', md, 'ok'],
  ['Notes/emoji \u{1F600}.md', md, 'ok'],
  // Format characters and unusual spaces are not control characters.
  ['Notes/a\u200Bb.md', md, 'ok'],
  ['Notes/a\u00A0b.md', md, 'ok'],
  ['Notes/a\u00ADb.md', md, 'ok'],
  ['Notes/a\u2028b.md', md, 'ok'],
  ['Notes/a\uFEFFb.md', md, 'ok'],
  ['Notes/a~b.md', md, 'ok'],
  // Only a top-level folder can be reserved, and a name is not a folder.
  ['Notes/.md', null, 'ok'],
  ['.md', null, 'ok'],
  ['Notes/noext', null, 'ok'],
  ['Notes/trailing-dot.', null, 'ok'],
  ['Notes/x.md.bak', null, 'ok'],
  ['Notes/x.md~', null, 'ok'],
  ['Notes/a.png.txt', null, 'ok'],
  ['Notes/a.png.md', md, 'ok'],
  // The extension is what follows the last dot of the LAST segment, exactly.
  ['Notes.v2/a.md', md, 'ok'],
  ['a.png/b', null, 'ok'],
  ['a.png/b.md', md, 'ok'],
  ['a.md/b.png', bin, 'ok'],
  ['Notes/a.md ', null, 'ok'],
  ['Notes/a.md ', null, 'ok'],
  ['Notes /a.md', md, 'ok'],
  ['Notes/ a.md', md, 'ok'],
  ['Notes/名前.PDF', bin, 'ok'],
  [`Notes/x.${'e'.repeat(1000)}`, null, 'ok'],
];

const ATTACHMENTS: readonly Row[] = [
  ...BINARY_EXTENSIONS.flatMap((extension): Row[] => [
    [`Attachments/asset.${extension}`, bin, 'ok'],
    [`Attachments/ASSET.${extension.toUpperCase()}`, bin, 'ok'],
    [`asset.${extension}`, bin, 'ok'],
  ]),
  ['Attachments/Mixed.JpEg', bin, 'ok'],
  ['a/b/c/deep.pdf', bin, 'ok'],
  ...EXCLUDED_EXTENSIONS.map((extension): Row => [
    `Attachments/asset.${extension}`,
    null,
    'ok',
  ]),
];

/** Dot-segments never sync, but only the top-level ones are reserved on the wire. */
const HIDDEN: readonly Row[] = [
  ['.hidden/x.md', null, 'ok'],
  ['.hidden/x.png', null, 'ok'],
  ['.x.md', null, 'ok'],
  ['.gitignore', null, 'ok'],
  ['.DS_Store', null, 'ok'],
  ['..hidden/x.md', null, 'ok'],
  ['...', null, 'ok'],
  ['Notes/.drafts/x.md', null, 'ok'],
  ['Notes/.x.md', null, 'ok'],
  ['Notes/.DS_Store', null, 'ok'],
  ['Notes/..a.md', null, 'ok'],
  ['Notes/.obsidian/x.md', null, 'ok'],
  ['Notes/.trash/x.md', null, 'ok'],
  ['x/.obsidian/appearance.json', null, 'ok'],
  ['.trash/x.md', null, 'reserved'],
  ['.TRASH/x.md', null, 'reserved'],
  ['.Trash/x.png', null, 'reserved'],
  ['.trash', null, 'reserved'],
  ['.trash/deep/er/x.md', null, 'reserved'],
  ['.obsidian', null, 'reserved'],
  ['.obsidian/x.md', null, 'reserved'],
  ['.obsidian/x.png', null, 'reserved'],
  ['.Obsidian/x.md', null, 'reserved'],
];

/** The reserved conflict folder, at the top level only, in any letter case. */
const CONFLICT_FOLDER_ROWS: readonly Row[] = [
  ['Havemind Conflicts/x.md', null, 'reserved'],
  ['Havemind Conflicts/Nested/x.png', null, 'reserved'],
  ['Havemind Conflicts/x.txt', null, 'reserved'],
  ['Havemind Conflicts', null, 'reserved'],
  ['havemind conflicts/x.md', null, 'reserved'],
  ['HAVEMIND CONFLICTS/x.md', null, 'reserved'],
  ['Havemind conflicts/x.md', null, 'reserved'],
  ['hAVEMIND cONFLICTS/x.pdf', null, 'reserved'],
  ['Havemind Conflicts/.hidden/x.md', null, 'reserved'],
  // A lookalike is an ordinary name.
  ['Havemind Conflicts.md', md, 'ok'],
  ['Havemind Conflicts Archive/x.md', md, 'ok'],
  ['Havemind  Conflicts/x.md', md, 'ok'],
  ['Havemind Conflict/x.md', md, 'ok'],
  ['HAVEM\u0130ND CONFL\u0130CTS/x.md', md, 'ok'],
  ['Notes/Havemind Conflicts/x.md', md, 'ok'],
  ['Notes/havemind conflicts/x.png', bin, 'ok'],
];

/** The `.obsidian/` appearance allowlist: what crosses, and what never does. */
const CONFIG: readonly Row[] = [
  ['.obsidian/appearance.json', md, 'ok'],
  ['.obsidian/app.json', md, 'ok'],
  ['.obsidian/core-plugins.json', md, 'ok'],
  ['.obsidian/graph.json', md, 'ok'],
  ['.obsidian/hotkeys.json', md, 'ok'],
  ['.obsidian/snippets/a.css', md, 'ok'],
  ['.obsidian/snippets/A.CSS', md, 'ok'],
  ['.obsidian/snippets/my snippet.css', md, 'ok'],
  ['.obsidian/snippets/.hidden.css', md, 'ok'],
  ['.obsidian/themes/T/theme.css', md, 'ok'],
  ['.obsidian/themes/T/manifest.json', md, 'ok'],
  ['.obsidian/themes/T/sub/deep.css', md, 'ok'],
  ['.obsidian/themes/T/a/b/c/d.css', md, 'ok'],
  ['.obsidian/themes/T/metadata.json', md, 'ok'],
  ['.obsidian/themes/T/mydata.json', md, 'ok'],
  ['.obsidian/themes/T/preview.png', bin, 'ok'],
  ['.obsidian/themes/T/banner.jpg', bin, 'ok'],
  ['.obsidian/themes/T/banner.jpeg', bin, 'ok'],
  ['.obsidian/themes/T/anim.gif', bin, 'ok'],
  ['.obsidian/themes/T/pic.webp', bin, 'ok'],
  ['.obsidian/themes/T/logo.svg', bin, 'ok'],
  ['.obsidian/themes/T/Logo.SVG', bin, 'ok'],
  // Everything else under .obsidian/ stays on the machine.
  ['.obsidian/plugins/x/main.js', null, 'reserved'],
  ['.obsidian/plugins/x/manifest.json', null, 'reserved'],
  ['.obsidian/plugins/x/styles.css', null, 'reserved'],
  ['.obsidian/plugins/x/data.json', null, 'reserved'],
  ['.obsidian/plugins/x/README.md', null, 'reserved'],
  ['.obsidian/plugins/x/icon.png', null, 'reserved'],
  ['.obsidian/plugins/havemind-sync/data.json', null, 'reserved'],
  ['.obsidian/community-plugins.json', null, 'reserved'],
  ['.obsidian/workspace.json', null, 'reserved'],
  ['.obsidian/workspace-mobile.json', null, 'reserved'],
  ['.obsidian/types.json', null, 'reserved'],
  ['.obsidian/bookmarks.json', null, 'reserved'],
  ['.obsidian/daily-notes.json', null, 'reserved'],
  // The allowlist is case-sensitive: a variant can only fall out of it.
  ['.obsidian/Appearance.json', null, 'reserved'],
  ['.obsidian/appearance.JSON', null, 'reserved'],
  ['.obsidian/Snippets/a.css', null, 'reserved'],
  ['.obsidian/THEMES/T/x.css', null, 'reserved'],
  ['.OBSIDIAN/appearance.json', null, 'reserved'],
  ['.Obsidian/snippets/a.css', null, 'reserved'],
  // Wrong shape or wrong extension inside an allowed subtree.
  ['.obsidian/snippets/nested/a.css', null, 'reserved'],
  ['.obsidian/snippets/a.scss', null, 'reserved'],
  ['.obsidian/snippets/a.txt', null, 'reserved'],
  ['.obsidian/snippets/a.js', null, 'reserved'],
  ['.obsidian/snippets/a.md', null, 'reserved'],
  ['.obsidian/snippets/a.png', null, 'reserved'],
  ['.obsidian/snippets/.css', null, 'reserved'],
  ['.obsidian/snippets/data.json', null, 'reserved'],
  ['.obsidian/themes/theme.css', null, 'reserved'],
  ['.obsidian/themes/T', null, 'reserved'],
  ['.obsidian/themes/T/x.pdf', null, 'reserved'],
  ['.obsidian/themes/T/x.js', null, 'reserved'],
  ['.obsidian/themes/T/x.woff2', null, 'reserved'],
  ['.obsidian/themes/T/x.wasm', null, 'reserved'],
  ['.obsidian/themes/T/x.ttf', null, 'reserved'],
  ['.obsidian/themes/T/x.md', null, 'reserved'],
  ['.obsidian/themes/T/x.txt', null, 'reserved'],
  ['.obsidian/themes/T/x.html', null, 'reserved'],
  // The secret store is matched as a whole segment, wherever it sits.
  ['.obsidian/themes/T/data.json', null, 'reserved'],
  ['.obsidian/themes/T/sub/data.json', null, 'reserved'],
  ['.obsidian/themes/data.json/x.css', null, 'reserved'],
  // A traversal or empty segment never re-enters through an allowed prefix.
  ['.obsidian/themes/../plugins/x/styles.css', null, 'segment'],
  ['.obsidian/themes/T/../../plugins/p/main.js', null, 'segment'],
  ['.obsidian/snippets/../plugins/x.css', null, 'segment'],
  ['.obsidian//appearance.json', null, 'segment'],
  ['.obsidian/themes//x.css', null, 'segment'],
  ['.obsidian/', null, 'segment'],
  ['.obsidian/themes/T/', null, 'segment'],
  ['.trash/', null, 'segment'],
];

/** Malformed paths: neither layer lets these through. */
const MALFORMED: readonly Row[] = [
  ['', null, 'empty'],
  ['/', null, 'relative'],
  ['/a.md', null, 'relative'],
  ['a.md/', null, 'segment'],
  ['Notes/', null, 'segment'],
  ['Notes//a.md', null, 'segment'],
  ['Notes/a.md//', null, 'segment'],
  ['.', null, 'segment'],
  ['..', null, 'segment'],
  ['./a.md', null, 'segment'],
  ['../a.md', null, 'segment'],
  ['../escape.md', null, 'segment'],
  ['Notes/../a.md', null, 'segment'],
  ['Notes/./a.md', null, 'segment'],
  ['a/b/../../../a.md', null, 'segment'],
  ['.trash//x.md', null, 'segment'],
];

/**
 * A backslash is normalised to a slash by the plugin before it decides, and
 * refused outright by the protocol: the raw path is never valid on the wire,
 * the normalised one is judged like any other.
 */
const BACKSLASHES: readonly Row[] = [
  ['Notes\\Plan.md', md, 'relative'],
  ['Notes\\sub\\pic.png', bin, 'relative'],
  ['Notes/sub\\mixed.md', md, 'relative'],
  ['a\\b\\c\\d.md', md, 'relative'],
  ['Notes\\Plan.txt', null, 'relative'],
  ['\\a.md', null, 'relative'],
  ['Notes\\..\\a.md', null, 'relative'],
  ['Notes\\\\a.md', null, 'relative'],
  ['.trash\\x.md', null, 'relative'],
  ['.hidden\\x.md', null, 'relative'],
  ['Havemind Conflicts\\x.md', null, 'relative'],
  ['havemind conflicts\\x.md', null, 'relative'],
  ['.obsidian\\snippets\\a.css', md, 'relative'],
  ['.obsidian\\themes\\T\\p.png', bin, 'relative'],
  ['.obsidian\\plugins\\x\\main.js', null, 'relative'],
];

/** NFC and NFD spellings of the same name decide identically. */
const UNICODE: readonly Row[] = [
  ['Notes/Caf\u00E9.md', md, 'ok'],
  ['Notes/Cafe\u0301.md', md, 'ok'],
  ['Cafe\u0301/note.md', md, 'ok'],
  ['Notes/\u1100\u1161.md', md, 'ok'],
  ['Notes/\u212A.md', md, 'ok'],
  ['Notes/Cafe\u0301.png', bin, 'ok'],
  ['Notes/Cafe\u0301.docx', null, 'ok'],
  ['.obsidian/themes/Cafe\u0301/theme.css', md, 'ok'],
  ['.obsidian/themes/Caf\u00E9/theme.css', md, 'ok'],
];

/** Names that only look long: no length limit exists in either layer. */
const LONG: readonly Row[] = [
  [`${'a'.repeat(250)}.md`, md, 'ok'],
  [`${'a'.repeat(5000)}.md`, md, 'ok'],
  [`${'a'.repeat(5000)}/x.png`, bin, 'ok'],
  [`${'a/'.repeat(300)}x.md`, md, 'ok'],
  [`${'a'.repeat(5000)}.docx`, null, 'ok'],
  [`.trash/${'a/'.repeat(300)}x.md`, null, 'reserved'],
  [`Havemind Conflicts/${'a'.repeat(5000)}.md`, null, 'reserved'],
  [`.obsidian/themes/${'T'.repeat(5000)}/theme.css`, md, 'ok'],
  [`.obsidian/plugins/${'p'.repeat(5000)}/main.js`, null, 'reserved'],
];

/**
 * PINNED DISAGREEMENT. The plugin admits these and the protocol refuses them,
 * so `buildRevisionEnvelope` throws for them at the moment a change is
 * committed. Today that surfaces as a per-file skip with the protocol's message
 * in a reconcile scan, and as a notice plus a failed-to-queue entry for a live
 * edit. Classifying them ineligible instead would silence both, so which way to
 * close the gap is the owner's call: this table records the behaviour as it is,
 * so that a change to it is a decision and not an accident.
 */
const ADMITTED_BUT_REFUSED: readonly Row[] = [
  // A leading `X:` reads as a Windows drive to the protocol.
  ['C:x.md', md, 'relative'],
  ['c:x.md', md, 'relative'],
  ['C:/x.md', md, 'relative'],
  ['Q: What is sync.md', md, 'relative'],
  ['Z:/pic.png', bin, 'relative'],
  ['C:.trash/x.md', md, 'relative'],
  // C0 and C1 control characters, tab and newline included.
  ['Notes/a\u0000b.md', md, 'control'],
  ['Notes/a\u0001b.md', md, 'control'],
  ['Notes/a\tb.md', md, 'control'],
  ['Notes/a\nb.md', md, 'control'],
  ['Notes/a\rb.md', md, 'control'],
  ['Notes/a\u001Fb.md', md, 'control'],
  ['Notes/a\u007Fb.md', md, 'control'],
  ['Notes/a\u0080b.md', md, 'control'],
  ['Notes/a\u0085b.md', md, 'control'],
  ['Notes/a\u009Fb.md', md, 'control'],
  ['Notes/a\u0001.png', bin, 'control'],
  ['.obsidian/snippets/a\u0001.css', md, 'control'],
  // The protocol reads the control character before it reads the root.
  ['.trash/a\u0001.md', null, 'control'],
];

const ROWS: readonly Row[] = [
  ...NOTES,
  ...ATTACHMENTS,
  ...HIDDEN,
  ...CONFLICT_FOLDER_ROWS,
  ...CONFIG,
  ...MALFORMED,
  ...BACKSLASHES,
  ...UNICODE,
  ...LONG,
  ...ADMITTED_BUT_REFUSED,
];

function label(path: string): string {
  const shown = JSON.stringify(path);
  return shown.length > 70
    ? `${shown.slice(0, 40)}... (${path.length} chars)`
    : shown;
}

function protocolVerdict(path: string): string {
  try {
    canonicalizeVaultPath(path);
    return 'ok';
  } catch (error) {
    return (error as Error).message;
  }
}

describe('vault path policy, the plugin verdict for every path', () => {
  it.each(ROWS.map(([path, plugin]) => ({ label: label(path), path, plugin })))(
    '$label',
    ({ path, plugin }) => {
      const classified = classifyVaultPath(path);

      if (plugin === null) {
        expect(classified).toEqual({ eligible: false });
      } else {
        expect(classified).toMatchObject({ eligible: true, kind: plugin });
      }
    },
  );
});

describe('vault path policy, the protocol verdict for every path', () => {
  it.each(
    ROWS.map(([path, , protocol]) => ({ label: label(path), path, protocol })),
  )('$label', ({ path, protocol }) => {
    if (protocol === 'ok') {
      expect(canonicalizeVaultPath(path)).toBe(path.normalize('NFC'));
    } else {
      expect(() => canonicalizeVaultPath(path)).toThrow(REFUSAL[protocol]);
    }
  });
});

describe('vault path policy, where the two layers meet', () => {
  it('covers every category the policy has', () => {
    const verdicts = new Set(ROWS.map(([, , protocol]) => protocol));
    const kinds = new Set(ROWS.map(([, plugin]) => plugin));

    expect(verdicts).toEqual(
      new Set(['ok', 'empty', 'relative', 'control', 'segment', 'reserved']),
    );
    expect(kinds).toEqual(new Set([md, bin, null]));
    expect(ROWS.length).toBeGreaterThanOrEqual(250);
  });

  it('passes on to the protocol only paths it accepts, bar the pinned disagreement', () => {
    const disagreements: string[] = [];

    for (const [path] of ROWS) {
      const classified = classifyVaultPath(path);
      if (!classified.eligible) continue;
      if (protocolVerdict(classified.canonicalPath) !== 'ok') {
        disagreements.push(path);
      }
    }

    // Exactly the eligible rows of the pinned group, no more and no fewer.
    expect(new Set(disagreements)).toEqual(
      new Set(
        ADMITTED_BUT_REFUSED.filter(([, plugin]) => plugin !== null).map(
          ([path]) => path,
        ),
      ),
    );
  });

  it('never lets the plugin admit a path the protocol reserves', () => {
    // The class of bug this file exists for: eligible here, then a reserved
    // root or a hidden segment throws at envelope build.
    for (const [path] of ROWS) {
      const classified = classifyVaultPath(path);
      if (!classified.eligible) continue;
      expect(protocolVerdict(classified.canonicalPath)).not.toMatch(
        /reserved|traversal/u,
      );
    }
  });
});

describe('vault path policy, canonical form and collision key', () => {
  it.each([
    ['Notes/Caf\u00E9.md', 'Notes/Caf\u00E9.md', 'notes/caf\u00E9.md'],
    ['Notes/Cafe\u0301.md', 'Notes/Caf\u00E9.md', 'notes/caf\u00E9.md'],
    ['Notes\\Sub\\Plan.md', 'Notes/Sub/Plan.md', 'notes/sub/plan.md'],
    ['Notes/Sub\\Plan.md', 'Notes/Sub/Plan.md', 'notes/sub/plan.md'],
    ['Notes/PLAN.MD', 'Notes/PLAN.MD', 'notes/plan.md'],
    ['Notes/Stra\u00DFe.md', 'Notes/Stra\u00DFe.md', 'notes/stra\u00DFe.md'],
    ['Notes/\u0130stanbul.md', 'Notes/\u0130stanbul.md', 'notes/i\u0307stanbul.md'],
    ['Notes/\u212A.md', 'Notes/K.md', 'notes/k.md'],
    ['Attachments/PIC.PNG', 'Attachments/PIC.PNG', 'attachments/pic.png'],
    [
      '.obsidian\\snippets\\A.css',
      '.obsidian/snippets/A.css',
      '.obsidian/snippets/a.css',
    ],
  ])('%j becomes %j, colliding as %j', (path, canonicalPath, collisionKey) => {
    expect(normalizeWirePath(path)).toBe(canonicalPath);
    expect(classifyVaultPath(path)).toMatchObject({
      canonicalPath,
      collisionKey,
      eligible: true,
    });
    // What the plugin sends is what the protocol would produce for it.
    expect(canonicalizeVaultPath(canonicalPath)).toBe(canonicalPath);
  });

  it('keeps two case variants of one path on one collision key', () => {
    const keys = ['Notes/Plan.md', 'notes/plan.md', 'NOTES/PLAN.MD'].map(
      (path) => {
        const classified = classifyVaultPath(path);
        return classified.eligible ? classified.collisionKey : null;
      },
    );

    expect(new Set(keys)).toEqual(new Set(['notes/plan.md']));
  });
});
