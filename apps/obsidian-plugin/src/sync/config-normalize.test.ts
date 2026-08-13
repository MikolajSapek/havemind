import { describe, expect, it } from 'vitest';

import {
  hasVolatileConfigFields,
  mergeConfigContent,
  normalizeConfigContent,
} from './config-normalize';

const GRAPH_PATH = '.obsidian/graph.json';

/** Every semantic key the graph view carries, with a recognisable value each. */
const SEMANTIC_GRAPH = {
  colorGroups: [{ query: 'tag:#work', color: { a: 1, rgb: 8087286 } }],
  search: 'tag:#work',
  showTags: true,
  showAttachments: false,
  hideUnresolved: true,
  showOrphans: false,
  showArrow: true,
  textFadeMultiplier: -0.5,
  nodeSizeMultiplier: 1.2,
  lineSizeMultiplier: 0.8,
  centerStrength: 0.518,
  repelStrength: 10,
  linkStrength: 1,
  linkDistance: 250,
} as const;

/** The machine-local view state Obsidian rewrites merely by opening the graph. */
const VOLATILE_GRAPH = {
  scale: 1.7391304347826086,
  close: true,
  'collapse-filter': true,
  'collapse-color-groups': false,
  'collapse-display': true,
  'collapse-forces': false,
} as const;

function graphJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

describe('hasVolatileConfigFields', () => {
  it('is true for the graph settings file only', () => {
    expect(hasVolatileConfigFields(GRAPH_PATH)).toBe(true);
    expect(hasVolatileConfigFields('.obsidian/appearance.json')).toBe(false);
    expect(hasVolatileConfigFields('.obsidian/app.json')).toBe(false);
    expect(hasVolatileConfigFields('.obsidian/hotkeys.json')).toBe(false);
    expect(hasVolatileConfigFields('.obsidian/snippets/x.css')).toBe(false);
    expect(hasVolatileConfigFields('Notes/Plan.md')).toBe(false);
  });

  it('accepts a Windows backslash separator for the same path', () => {
    expect(hasVolatileConfigFields('.obsidian\\graph.json')).toBe(true);
  });
});

describe('normalizeConfigContent', () => {
  it('SPLIT CONTRACT: every named setting syncs, only the six view-state keys do not', () => {
    // USER DECISION, 2026-08-13, stated key by key. Everything the user can
    // choose in the graph view — colour groups, the size multipliers, the filter
    // toggles, the force sliders — is a SETTING and must reach the other device.
    // Only the six keys that describe the current view's shape on this screen
    // stay behind. Enumerated here so a future edit to the volatile set cannot
    // quietly demote a setting (or start syncing a zoom level) without a red test.
    const MUST_SYNC = [
      'colorGroups',
      'nodeSizeMultiplier',
      'lineSizeMultiplier',
      'textFadeMultiplier',
      'search',
      'showTags',
      'showAttachments',
      'hideUnresolved',
      'showOrphans',
      'showArrow',
      'centerStrength',
      'repelStrength',
      'linkStrength',
      'linkDistance',
    ];
    const MUST_NOT_SYNC = [
      'scale',
      'close',
      'collapse-filter',
      'collapse-color-groups',
      'collapse-display',
      'collapse-forces',
    ];

    const normalized = JSON.parse(
      normalizeConfigContent(
        GRAPH_PATH,
        graphJson({ ...SEMANTIC_GRAPH, ...VOLATILE_GRAPH }),
      ),
    ) as Record<string, unknown>;

    expect(Object.keys(normalized).sort()).toEqual([...MUST_SYNC].sort());
    for (const key of MUST_NOT_SYNC) {
      expect(normalized).not.toHaveProperty(key);
    }
    // The two the user named first, spelled out: the colours and the node size
    // survive with their exact values while the zoom is gone.
    expect(normalized.colorGroups).toEqual(SEMANTIC_GRAPH.colorGroups);
    expect(normalized.nodeSizeMultiplier).toBe(SEMANTIC_GRAPH.nodeSizeMultiplier);
    expect(normalized.scale).toBeUndefined();
    // And the two lists are exhaustive: nothing is both, nothing is neither.
    expect(
      [...MUST_SYNC, ...MUST_NOT_SYNC].sort(),
    ).toEqual(
      [...Object.keys(SEMANTIC_GRAPH), ...Object.keys(VOLATILE_GRAPH)].sort(),
    );
  });

  it('drops every volatile view-state key from graph.json', () => {
    const text = graphJson({ ...VOLATILE_GRAPH, ...SEMANTIC_GRAPH });

    const normalized = JSON.parse(normalizeConfigContent(GRAPH_PATH, text)) as Record<
      string,
      unknown
    >;

    expect(Object.keys(normalized).sort()).toEqual(
      Object.keys(SEMANTIC_GRAPH).sort(),
    );
    for (const key of Object.keys(VOLATILE_GRAPH)) {
      expect(normalized).not.toHaveProperty(key);
    }
  });

  it('keeps every semantic graph setting byte-for-byte', () => {
    const text = graphJson({ ...SEMANTIC_GRAPH, ...VOLATILE_GRAPH });

    const normalized = JSON.parse(normalizeConfigContent(GRAPH_PATH, text));

    expect(normalized).toEqual(SEMANTIC_GRAPH);
  });

  it('keeps an UNKNOWN key — forward compatibility with a newer Obsidian', () => {
    // An unrecognised key is kept on purpose: dropping it would silently stop
    // syncing a setting a future Obsidian release adds.
    const text = graphJson({ scale: 2, futureGraphSetting: 'keep-me' });

    const normalized = JSON.parse(normalizeConfigContent(GRAPH_PATH, text));

    expect(normalized).toEqual({ futureGraphSetting: 'keep-me' });
  });

  it('is a no-op when only volatile keys change — the same output for both reads', () => {
    // This is the whole point of the filter: opening the graph view rewrites
    // `scale`/`collapse-*` and must hash EQUAL to the previous read.
    const before = graphJson({ ...SEMANTIC_GRAPH, scale: 1, 'collapse-filter': true });
    const after = graphJson({
      ...SEMANTIC_GRAPH,
      scale: 3.14159,
      'collapse-filter': false,
      close: true,
    });

    expect(normalizeConfigContent(GRAPH_PATH, after)).toBe(
      normalizeConfigContent(GRAPH_PATH, before),
    );
  });

  it('is idempotent — normalising an already-normalised payload changes nothing', () => {
    const once = normalizeConfigContent(
      GRAPH_PATH,
      graphJson({ ...VOLATILE_GRAPH, ...SEMANTIC_GRAPH }),
    );

    expect(normalizeConfigContent(GRAPH_PATH, once)).toBe(once);
  });

  it('returns unparseable content unchanged', () => {
    const broken = '{ "colorGroups": [,,, ';

    expect(normalizeConfigContent(GRAPH_PATH, broken)).toBe(broken);
  });

  it('returns a JSON value that is not an object unchanged', () => {
    expect(normalizeConfigContent(GRAPH_PATH, '[1,2,3]')).toBe('[1,2,3]');
    expect(normalizeConfigContent(GRAPH_PATH, 'null')).toBe('null');
    expect(normalizeConfigContent(GRAPH_PATH, '"text"')).toBe('"text"');
  });

  it('tolerates a UTF-8 BOM before the JSON object', () => {
    const text = `\uFEFF${JSON.stringify({ scale: 2, showTags: true })}`;

    expect(JSON.parse(normalizeConfigContent(GRAPH_PATH, text))).toEqual({
      showTags: true,
    });
  });

  it('returns every OTHER path unchanged, config or not', () => {
    const appearance = '{"accentColor":"#7c3aed","scale":9}';
    expect(normalizeConfigContent('.obsidian/appearance.json', appearance)).toBe(
      appearance,
    );
    expect(normalizeConfigContent('.obsidian/snippets/x.css', 'body{}')).toBe(
      'body{}',
    );
    expect(normalizeConfigContent('Notes/Plan.md', '# Plan\n')).toBe('# Plan\n');
  });

  it('strips a volatile key wherever it sits in the source object', () => {
    // Key order of the OUTPUT follows the source object, so a volatile key
    // before the semantic ones must normalise to the same bytes as one after.
    const before = normalizeConfigContent(
      GRAPH_PATH,
      graphJson({ scale: 1, showTags: true }),
    );
    const after = normalizeConfigContent(
      GRAPH_PATH,
      graphJson({ showTags: true, close: false }),
    );

    expect(after).toBe(before);
  });
});

describe('mergeConfigContent', () => {
  it("overlays the remote's semantic keys and preserves the LOCAL view state", () => {
    const local = graphJson({
      ...VOLATILE_GRAPH,
      colorGroups: [{ query: 'tag:#old', color: { a: 1, rgb: 1 } }],
      showTags: false,
    });
    const remote = normalizeConfigContent(
      GRAPH_PATH,
      graphJson({ scale: 999, colorGroups: SEMANTIC_GRAPH.colorGroups, showTags: true }),
    );

    const merged = JSON.parse(mergeConfigContent(GRAPH_PATH, local, remote)) as Record<
      string,
      unknown
    >;

    // The peer's colours landed…
    expect(merged.colorGroups).toEqual(SEMANTIC_GRAPH.colorGroups);
    expect(merged.showTags).toBe(true);
    // …and this machine's own zoom/fold state survived untouched.
    expect(merged.scale).toBe(VOLATILE_GRAPH.scale);
    expect(merged['collapse-filter']).toBe(true);
    expect(merged.close).toBe(true);
  });

  it('drops a semantic key the remote no longer carries', () => {
    // A colour group the peer DELETED must disappear here too — an overlay that
    // only ever adds keys would keep a removed group alive forever.
    const local = graphJson({ scale: 2, colorGroups: [{ query: 'gone' }], showTags: true });
    const remote = normalizeConfigContent(GRAPH_PATH, graphJson({ showTags: true }));

    const merged = JSON.parse(mergeConfigContent(GRAPH_PATH, local, remote)) as Record<
      string,
      unknown
    >;

    expect(merged).not.toHaveProperty('colorGroups');
    expect(merged.showTags).toBe(true);
    expect(merged.scale).toBe(2);
  });

  it('normalises the remote payload when a legacy peer sent its volatile keys too', () => {
    const local = graphJson({ scale: 4, showTags: false });
    const legacyRemote = graphJson({ scale: 999, close: true, showTags: true });

    const merged = JSON.parse(
      mergeConfigContent(GRAPH_PATH, local, legacyRemote),
    ) as Record<string, unknown>;

    expect(merged.scale).toBe(4);
    expect(merged.close).toBeUndefined();
    expect(merged.showTags).toBe(true);
  });

  it('writes the remote semantic content when there is no local file yet', () => {
    const remote = normalizeConfigContent(GRAPH_PATH, graphJson(SEMANTIC_GRAPH));

    const merged = mergeConfigContent(GRAPH_PATH, null, remote);

    expect(JSON.parse(merged)).toEqual(SEMANTIC_GRAPH);
  });

  it('replaces an unparseable local file with the remote semantic content', () => {
    const remote = normalizeConfigContent(GRAPH_PATH, graphJson({ showTags: true }));

    expect(JSON.parse(mergeConfigContent(GRAPH_PATH, '{{{ broken', remote))).toEqual({
      showTags: true,
    });
  });

  it('re-normalises to exactly the remote payload — the write can never echo back', () => {
    // The producer re-reads what was written and normalises it. That result MUST
    // equal the payload the peer pushed, or the poller would enqueue a revision
    // for a file it just received (the ping-pong this fix removes).
    const local = graphJson({ ...VOLATILE_GRAPH, showTags: false });
    const remote = normalizeConfigContent(
      GRAPH_PATH,
      graphJson({ ...SEMANTIC_GRAPH, ...VOLATILE_GRAPH }),
    );

    const merged = mergeConfigContent(GRAPH_PATH, local, remote);

    expect(normalizeConfigContent(GRAPH_PATH, merged)).toBe(remote);
  });

  it('passes a non-volatile path straight through — the remote content wins whole', () => {
    const remote = '{"accentColor":"#7c3aed"}';

    expect(
      mergeConfigContent('.obsidian/appearance.json', '{"accentColor":"#000"}', remote),
    ).toBe(remote);
    expect(mergeConfigContent('Notes/Plan.md', 'old\n', 'new\n')).toBe('new\n');
  });

  it('passes unparseable REMOTE content through unchanged', () => {
    const broken = '{ not json';

    expect(mergeConfigContent(GRAPH_PATH, graphJson({ scale: 1 }), broken)).toBe(broken);
  });
});
