import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Drift guard for `src/obsidian.d.ts`.
 *
 * The plugin typechecks against a hand-written ambient `declare module
 * 'obsidian'` block instead of the packaged typings, so `tsc` can never notice
 * when Obsidian renames or removes an API the ambient file still promises. The
 * result would be a green build and a plugin that throws at runtime.
 *
 * This test closes that gap from the outside: it reads BOTH declaration files
 * from disk and asserts that every identifier the ambient file declares still
 * occurs, as a whole word, in the installed `obsidian` typings. It is a
 * name-level presence check, not a structural one — it will not catch a changed
 * signature, but it does catch the failure mode that matters most, a member
 * that has simply gone away.
 */

const require_ = createRequire(import.meta.url);

const AMBIENT_PATH = fileURLToPath(new URL('./obsidian.d.ts', import.meta.url));

/**
 * Identifiers the ambient file declares that upstream deliberately does NOT,
 * because they are Havemind's own inventions rather than Obsidian API names.
 * Every entry needs a justification — this list is not a place to silence a
 * genuine drift failure.
 *
 * - `EditorExtension`: our own alias. Obsidian declares
 *   `registerEditorExtension(extension: Extension): void`, where `Extension`
 *   comes from `@codemirror/state` — an upstream peer dependency this plugin
 *   does not install. `EditorExtension = readonly unknown[]` is the local
 *   stand-in for that type, so the NAME belongs to us; only the method it is
 *   passed to (`registerEditorExtension`, which is checked) belongs to Obsidian.
 */
const LOCAL_INVENTIONS: ReadonlySet<string> = new Set(['EditorExtension']);

/**
 * `constructor` is a language keyword rather than an API name, so its presence
 * upstream proves nothing. Names shorter than three characters (`id`, `on`) are
 * too generic for a whole-word search to carry any signal.
 */
const MINIMUM_NAME_LENGTH = 3;
const KEYWORD_MEMBERS: ReadonlySet<string> = new Set(['constructor']);

/**
 * Floor for the extracted-name count. Guards against the parser below silently
 * degrading to a handful of names, which would leave the drift assertion
 * passing vacuously.
 */
const MINIMUM_EXTRACTED_NAMES = 100;

interface InstalledTypings {
  readonly path: string;
  readonly source: string;
  readonly version: string;
}

/**
 * Resolves the installed typings through the package manifest rather than a
 * hardcoded `node_modules` path, so hoisting and a future upstream rename of
 * the `.d.ts` file both stay handled. Returns `undefined` when the package is
 * absent (a production install without devDependencies).
 */
function locateInstalledTypings(): InstalledTypings | undefined {
  try {
    const manifestPath = require_.resolve('obsidian/package.json');
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }

    const manifest = parsed as Record<string, unknown>;
    const types = manifest['types'];
    const version = manifest['version'];
    const typingsPath = resolve(
      dirname(manifestPath),
      typeof types === 'string' ? types : 'obsidian.d.ts',
    );

    return {
      path: typingsPath,
      source: readFileSync(typingsPath, 'utf8'),
      version: typeof version === 'string' ? version : 'unknown',
    };
  } catch {
    return undefined;
  }
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

function firstCapture(pattern: RegExp, text: string): string | undefined {
  const match = pattern.exec(text);
  if (match === null) {
    return undefined;
  }

  const [, captured] = match;
  return captured;
}

const BLOCK_DECLARATION =
  /(?:^|\s)(?:abstract\s+)?(?:class|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/;
const FLAT_DECLARATION = /(?:^|\s)(?:type|function)\s+([A-Za-z_$][\w$]*)/;
const MEMBER_MODIFIER =
  /^(?:readonly|abstract|static|declare|export|public|private|protected|get|set)\s+/;
const MEMBER_NAME = /^([A-Za-z_$][\w$]*)\s*\??\s*[(:<]/;

function declarationName(chunk: string): string | undefined {
  return (
    firstCapture(BLOCK_DECLARATION, chunk) ??
    firstCapture(FLAT_DECLARATION, chunk)
  );
}

/**
 * Reads a member name off a flattened `name(...): T` / `readonly name: T`
 * chunk. Index signatures (`[key: string]: string`) never match, which is
 * intended — their key type is not an API name.
 */
function memberName(chunk: string): string | undefined {
  let rest = chunk.trim();
  while (MEMBER_MODIFIER.test(rest)) {
    rest = rest.replace(MEMBER_MODIFIER, '');
  }

  return firstCapture(MEMBER_NAME, rest);
}

/**
 * Pragmatic parser for our own 260-line ambient file — no new dependency, and
 * no need for the generality of the TypeScript compiler API. Walks the
 * comment-stripped source tracking parenthesis depth, so that a `{`, `}` or `;`
 * only ends a chunk when it is not inside a parameter list; parameter names
 * therefore never leak in as members.
 */
function extractDeclaredNames(source: string): ReadonlySet<string> {
  const names = new Set<string>();
  let buffer = '';
  let parenDepth = 0;

  const flush = (chunk: string, headerOnly: boolean): void => {
    const name = headerOnly
      ? declarationName(chunk)
      : (declarationName(chunk) ?? memberName(chunk));
    if (name !== undefined) {
      names.add(name);
    }
  };

  for (const character of stripComments(source)) {
    if (character === '(') {
      parenDepth += 1;
    } else if (character === ')') {
      parenDepth -= 1;
    } else if (parenDepth === 0 && character === '{') {
      flush(buffer, true);
      buffer = '';
      continue;
    } else if (parenDepth === 0 && (character === '}' || character === ';')) {
      flush(buffer, false);
      buffer = '';
      continue;
    }

    buffer += character;
  }

  flush(buffer, false);
  return names;
}

function checkableNames(source: string): readonly string[] {
  return [...extractDeclaredNames(source)]
    .filter(
      (name) =>
        name.length >= MINIMUM_NAME_LENGTH &&
        !KEYWORD_MEMBERS.has(name) &&
        !LOCAL_INVENTIONS.has(name),
    )
    .sort();
}

function occursAsWord(name: string, haystack: string): boolean {
  return new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(haystack);
}

const ambientSource = readFileSync(AMBIENT_PATH, 'utf8');
const installed = locateInstalledTypings();

describe('hand-written obsidian.d.ts', () => {
  it('extracts declaration and member names from the ambient file', () => {
    const names = extractDeclaredNames(ambientSource);

    // Declarations: exported class, interface, type alias, free function, and
    // the global HTMLElement augmentation.
    expect(names).toContain('Plugin');
    expect(names).toContain('DataAdapter');
    expect(names).toContain('EventRef');
    expect(names).toContain('requestUrl');
    expect(names).toContain('HTMLElement');

    // Members: plain property, readonly property, method, optional method, and
    // an abstract method.
    expect(names).toContain('configDir');
    expect(names).toContain('manifest');
    expect(names).toContain('registerObsidianProtocolHandler');
    expect(names).toContain('trigger');
    expect(names).toContain('getViewType');

    // Parameter names and index-signature keys are not API surface.
    expect(names).not.toContain('normalizedPath');
    expect(names).not.toContain('settingTab');

    expect(checkableNames(ambientSource).length).toBeGreaterThanOrEqual(
      MINIMUM_EXTRACTED_NAMES,
    );
  });

  if (installed === undefined) {
    it.skip(
      'declares no API absent from the installed obsidian typings — SKIPPED: ' +
        'the obsidian package is not installed, run `npm ci` at the repo root ' +
        'to enable this drift guard',
      () => undefined,
    );
    return;
  }

  it('declares no API absent from the installed obsidian typings', () => {
    // Comments are stripped from the upstream side too: a name that survives
    // only in a JSDoc paragraph is not a live API.
    const upstream = stripComments(installed.source);
    const names = checkableNames(ambientSource);
    const missing = names.filter((name) => !occursAsWord(name, upstream));

    expect(
      missing,
      `hand-written obsidian.d.ts declares an API absent from ` +
        `obsidian@${installed.version} — update the ambient declaration. ` +
        `Missing (${String(missing.length)} of ${String(names.length)} ` +
        `checked): ${missing.join(', ')}. Compared against ${installed.path}.`,
    ).toEqual([]);
  });
});
