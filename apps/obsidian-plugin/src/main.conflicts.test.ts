import { beforeEach, describe, expect, it, vi } from 'vitest';

import HavemindPlugin, {
  ConflictResolveModal,
  HavemindOnboardingView,
  buildConflictModalModel,
  renderConflictModalBody,
  renderConflictSection,
} from './main';
import type { PluginManifest } from './test/obsidian.mock';
import type { ConflictCopy } from './runtime/conflict-resolution';
import { buildConnectionPanel } from './runtime/status';
import type { RejoinRosterView } from './runtime/rejoin-roster';
import {
  App,
  ItemView,
  type MockElement,
  resetObsidianMock,
  WorkspaceLeaf,
} from './test/obsidian.mock';

function flatten(element: MockElement): MockElement[] {
  return element.children.flatMap((child) => [child, ...flatten(child)]);
}

/** A blank rendered pane element, mirroring an ItemView's content child. */
function createContent(): MockElement {
  const view = new ItemView(new WorkspaceLeaf());
  return view.containerEl.children[1] as unknown as MockElement;
}

/** The exported render helpers are typed against the real HTMLElement. */
function asEl(element: MockElement): HTMLElement {
  return element as unknown as HTMLElement;
}

function newCopy(overrides: Partial<ConflictCopy> = {}): ConflictCopy {
  return {
    copyPath: 'Havemind Conflicts/Notatka (conflict Magda 2026-07-16 1542).md',
    copyName: 'Notatka (conflict Magda 2026-07-16 1542).md',
    kind: 'new',
    noteName: 'Notatka',
    author: 'Magda',
    timestamp: '2026-07-16 1542',
    isBinary: false,
    targetPath: 'Notatka.md',
    targetKnown: true,
    manualHint: null,
    ...overrides,
  };
}

describe('renderConflictSection', () => {
  it('renders nothing when there are no conflict copies', () => {
    const container = createContent();
    renderConflictSection(asEl(container), [], { onResolve: () => undefined });
    expect(container.children).toHaveLength(0);
  });

  it('states the count in the heading, with one Resolve button per copy', () => {
    const container = createContent();
    const resolved: string[] = [];
    const copies = [newCopy(), newCopy({ copyPath: 'x', copyName: 'y', author: 'Ola' })];

    renderConflictSection(asEl(container), copies, {
      onResolve: (path) => resolved.push(path),
    });

    const all = flatten(container);
    // The count reads as a sentence ("2 conflicts"), not as a bare numeral
    // parked at the far edge of the row — where the design found it looked like
    // a badge belonging to whatever sat next to it.
    const header = all.find((e) =>
      e.classes.includes('havemind-conflict-header'),
    );
    // The mock keeps `text` per element rather than aggregating descendants, so
    // the count is read from the heading's own label span.
    expect(header).toBeDefined();
    expect(
      flatten(header ?? container).some((e) => e.text.includes('2 conflicts')),
    ).toBe(true);
    const buttons = all.filter((e) => e.text === 'Resolve');
    expect(buttons).toHaveLength(2);
    buttons[0]?.triggerClick();
    expect(resolved).toEqual([copies[0]?.copyPath]);
  });

  it('shows the manual hint on a copy with no derivable target', () => {
    const container = createContent();
    renderConflictSection(
      asEl(container),
      [newCopy({ targetKnown: false, targetPath: null, manualHint: 'Target unknown — open files manually.' })],
      { onResolve: () => undefined },
    );
    const all = flatten(container);
    expect(all.some((e) => e.text.includes('Target unknown'))).toBe(true);
  });
});

describe('buildConflictModalModel', () => {
  it('carries a diff for a text copy with a known target', () => {
    const model = buildConflictModalModel(newCopy(), [
      { type: 'context', text: 'a' },
    ]);
    expect(model.diff).not.toBeNull();
    expect(model.targetKnown).toBe(true);
    expect(model.author).toBe('Magda');
  });

  it('has a null diff and a hint for a binary copy', () => {
    const model = buildConflictModalModel(
      newCopy({ isBinary: true, manualHint: 'Binary conflict — open files manually.' }),
      null,
    );
    expect(model.diff).toBeNull();
    expect(model.manualHint).not.toBeNull();
  });
});

describe('renderConflictModalBody', () => {
  it('colour-codes diff lines and wires the three actions', () => {
    const container = createContent();
    const calls: string[] = [];
    renderConflictModalBody(
      asEl(container),
      buildConflictModalModel(newCopy(), [
        { type: 'context', text: 'same' },
        { type: 'removed', text: 'mine' },
        { type: 'added', text: 'theirs' },
      ]),
      {
        onKeepMine: () => calls.push('mine'),
        onKeepTheirs: () => calls.push('theirs'),
        onKeepBoth: () => calls.push('both'),
      },
    );

    const all = flatten(container);
    expect(all.some((e) => e.classes.includes('havemind-conflict-line-added'))).toBe(true);
    expect(all.some((e) => e.classes.includes('havemind-conflict-line-removed'))).toBe(true);

    const keepBoth = all.find((e) => e.text === 'Keep both (close)');
    keepBoth?.triggerClick();
    expect(calls).toEqual(['both']);
  });

  it('requires a two-step confirm for the destructive Keep mine', () => {
    const container = createContent();
    const calls: string[] = [];
    renderConflictModalBody(asEl(container), buildConflictModalModel(newCopy(), []), {
      onKeepMine: () => calls.push('mine'),
      onKeepTheirs: () => calls.push('theirs'),
      onKeepBoth: () => calls.push('both'),
    });

    const keepMine = flatten(container).find((e) => e.text === 'Keep mine');
    keepMine?.triggerClick();
    expect(calls).toEqual([]); // armed, not fired
    expect(keepMine?.text).toBe('Confirm keep mine');
    keepMine?.triggerClick();
    expect(calls).toEqual(['mine']);
  });

  it('omits Keep theirs when the target is unknown', () => {
    const container = createContent();
    renderConflictModalBody(
      asEl(container),
      buildConflictModalModel(
        newCopy({ targetKnown: false, targetPath: null, manualHint: 'Target unknown.' }),
        null,
      ),
      {
        onKeepMine: () => undefined,
        onKeepTheirs: () => undefined,
        onKeepBoth: () => undefined,
      },
    );
    const all = flatten(container);
    expect(all.some((e) => e.text === 'Keep theirs')).toBe(false);
    expect(all.some((e) => e.text === 'Keep mine')).toBe(true);
    expect(all.some((e) => e.text === 'Keep both (close)')).toBe(true);
  });
});

describe('ConflictResolveModal', () => {
  it('renders its body into contentEl when opened', () => {
    const modal = new ConflictResolveModal(
      new App(),
      buildConflictModalModel(newCopy(), [{ type: 'context', text: 'a' }]),
      { onKeepBoth: () => undefined },
    );
    modal.open();
    expect((modal as unknown as { opened: boolean }).opened).toBe(true);
    const all = flatten(modal.contentEl as unknown as MockElement);
    expect(all.some((e) => e.text === 'Keep both (close)')).toBe(true);
  });
});

describe('HavemindOnboardingView conflict section', () => {
  beforeEach(() => resetObsidianMock());

  it('renders the conflict section only when copies exist', () => {
    const withCopies = new HavemindOnboardingView(new WorkspaceLeaf(), {
      conflictsProvider: () => [newCopy()],
      onResolveConflict: () => undefined,
    });
    withCopies.onOpen();
    const content = (withCopies.containerEl as unknown as MockElement).children[1] as MockElement;
    expect(
      flatten(content).some((e) => e.classes.includes('havemind-conflict-header')),
    ).toBe(true);
  });

  it('hides the conflict section when there are no copies', () => {
    const empty = new HavemindOnboardingView(new WorkspaceLeaf(), {
      conflictsProvider: () => [],
      onResolveConflict: () => undefined,
    });
    empty.onOpen();
    const content = (empty.containerEl as unknown as MockElement).children[1] as MockElement;
    expect(
      flatten(content).some((e) => e.classes.includes('havemind-conflict-header')),
    ).toBe(false);
  });

  it('opens a resolve flow when a Resolve button is clicked', () => {
    const onResolveConflict = vi.fn();
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      conflictsProvider: () => [newCopy()],
      onResolveConflict,
    });
    view.onOpen();
    const content = (view.containerEl as unknown as MockElement).children[1] as MockElement;
    const resolve = flatten(content).find((e) => e.text === 'Resolve');
    resolve?.triggerClick();
    expect(onResolveConflict).toHaveBeenCalledWith(newCopy().copyPath);
  });
});

describe('HavemindOnboardingView per-section render isolation (MAJOR 5)', () => {
  beforeEach(() => resetObsidianMock());

  it('keeps the other sections rendering when one section provider throws', () => {
    const roster: RejoinRosterView = {
      empty: false,
      rows: [
        {
          membershipId: 'm1',
          displayName: 'Magda',
          role: 'editor',
          connected: true,
          statusLabel: 'connected',
          rejoinable: false,
          removable: false,
          colorToken: '--havemind-author-1',
          self: false,
        },
      ],
    };
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () => buildConnectionPanel({ status: 'synced' }),
      rejoinRosterProvider: () => roster,
      // A synchronous provider throw must not blank the whole panel.
      conflictsProvider: () => {
        throw new Error('conflicts provider boom');
      },
      onResolveConflict: () => undefined,
    });
    view.onOpen();
    const content = (view.containerEl as unknown as MockElement)
      .children[1] as MockElement;
    const all = flatten(content);

    // Status and the tab strip still render despite the conflicts throw. The
    // strip matters most here: it is built before the guarded sections, so an
    // unguarded read inside it would blank the pane rather than one section.
    expect(all.some((e) => e.classes.includes('havemind-status'))).toBe(true);
    expect(all.some((e) => e.attrs['role'] === 'tab')).toBe(true);
    // The failed section degrades to an inline English fallback, not a blank pane.
    const fallback = all.find((e) =>
      e.classes.includes('havemind-section-error'),
    );
    expect(fallback?.text).toBe('Section unavailable');
  });
});

const manifest: PluginManifest = {
  author: 'Mikolaj Pawel Sapek',
  description: 'Synchronize shared Markdown vaults with durable history.',
  id: 'havemind-sync',
  isDesktopOnly: true,
  minAppVersion: '1.11.4',
  name: 'Havemind',
  version: '0.0.1',
};

interface FakeFile {
  path: string;
  name: string;
}

/** An in-memory vault carrying one conflict copy and its target note. */
function fakeVaultWithConflict(): {
  vault: unknown;
  modified: Array<{ path: string; content: string }>;
  deleted: string[];
} {
  const copyPath = 'Havemind Conflicts/Notatka (conflict Magda 2026-07-16 1542).md';
  const files: FakeFile[] = [
    { path: 'deep/Notatka.md', name: 'Notatka.md' },
    { path: copyPath, name: 'Notatka (conflict Magda 2026-07-16 1542).md' },
  ];
  const contents: Record<string, string> = {
    'deep/Notatka.md': 'line one\nmine\nline three',
    [copyPath]: 'line one\ntheirs\nline three',
  };
  const modified: Array<{ path: string; content: string }> = [];
  const deleted: string[] = [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const vault = {
    getFiles: () => files,
    getAbstractFileByPath: (path: string) => byPath.get(path) ?? null,
    read: async (file: FakeFile) => contents[file.path] ?? '',
    modify: async (file: FakeFile, content: string) => {
      modified.push({ path: file.path, content });
    },
    delete: async (file: FakeFile) => {
      deleted.push(file.path);
    },
  };
  return { vault, modified, deleted };
}

describe('HavemindPlugin conflict resolution flow', () => {
  beforeEach(() => resetObsidianMock());

  it('opens a diff modal and keepTheirs writes the note then deletes the copy', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    plugin.onload();

    const { vault, modified, deleted } = fakeVaultWithConflict();
    (app as unknown as { vault: unknown }).vault = vault;

    const open = (
      plugin as unknown as {
        openConflictModal: (p: string) => Promise<ConflictResolveModal | null>;
      }
    ).openConflictModal.bind(plugin);

    const modal = await open(
      'Havemind Conflicts/Notatka (conflict Magda 2026-07-16 1542).md',
    );
    expect(modal).not.toBeNull();

    const all = flatten((modal as ConflictResolveModal).contentEl as unknown as MockElement);
    // The diff shows the diverging line from both sides.
    expect(all.some((e) => e.text.includes('mine'))).toBe(true);
    expect(all.some((e) => e.text.includes('theirs'))).toBe(true);

    const keepTheirs = all.find((e) => e.text === 'Keep theirs');
    keepTheirs?.triggerClick(); // arm
    keepTheirs?.triggerClick(); // confirm
    // Flush the async resolve chain (readText → writeText → deleteFile → then).
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(modified).toEqual([
      { path: 'deep/Notatka.md', content: 'line one\ntheirs\nline three' },
    ]);
    expect(deleted).toEqual([
      'Havemind Conflicts/Notatka (conflict Magda 2026-07-16 1542).md',
    ]);
  });

  it('resolves nothing for an unknown copy path', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    plugin.onload();
    const { vault } = fakeVaultWithConflict();
    (app as unknown as { vault: unknown }).vault = vault;

    const modal = await (
      plugin as unknown as {
        openConflictModal: (p: string) => Promise<ConflictResolveModal | null>;
      }
    ).openConflictModal('Havemind Conflicts/does-not-exist.md');
    expect(modal).toBeNull();
  });
});
