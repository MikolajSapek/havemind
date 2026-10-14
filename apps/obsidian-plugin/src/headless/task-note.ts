/**
 * An agent's task note (plan 014): `Havemind/Agents/<Name>.md` in the vault.
 *
 *   ---
 *   may_write: [Inbox, Notes/Filed]
 *   every: 30m
 *   ---
 *   Plain-language instructions.
 *
 * People write and edit it in Obsidian; it syncs like any note. The agent
 * reads it before every run, so a change takes effect on the next run. Scope is
 * kept by the agent's client (the server never sees paths, rule 2), and every
 * change can be undone, so a mistake costs one click.
 */

import { CONFLICT_FOLDER } from '../runtime/conflict-resolution';

export const AGENTS_FOLDER = 'Havemind/Agents';

const DEFAULT_EVERY_MINUTES = 60;
const UNIT_MINUTES: Readonly<Record<string, number>> = { m: 1, h: 60, d: 24 * 60 };

/** Places no task note can open to an agent: its own instructions, settings, conflicts, trash. */
const NEVER = ['Havemind', '.obsidian', CONFLICT_FOLDER, '.trash'];

export interface AgentTask {
  /** Folders the agent may create and change notes in (and below). */
  readonly mayWrite: readonly string[];
  readonly everyMinutes: number;
  readonly instructions: string;
}

export function taskNotePath(agentName: string): string {
  return `${AGENTS_FOLDER}/${agentName}.md`;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(["']).*\1$/u.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function cleanFolder(value: string): string {
  return unquote(value).replace(/^\/+|\/+$/gu, '');
}

function parseEvery(value: string | undefined): number {
  const match = /^(\d+)\s*([mhd])$/u.exec(value?.trim() ?? '');
  if (match === null) return DEFAULT_EVERY_MINUTES;
  return Math.max(1, Number(match[1])) * (UNIT_MINUTES[match[2] ?? 'h'] ?? 60);
}

/** Frontmatter keys this note uses: `key: value`, `key: [a, b]` or a `- item` list. */
function readFrontmatter(lines: readonly string[]): Map<string, string | string[]> {
  const fields = new Map<string, string | string[]>();
  let listKey: string | null = null;
  for (const line of lines) {
    const item = /^\s+-\s+(.*)$/u.exec(line);
    if (item !== null && listKey !== null) {
      const list = fields.get(listKey);
      if (Array.isArray(list)) list.push(item[1] ?? '');
      continue;
    }
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/u.exec(line);
    if (pair === null) continue;
    const key = pair[1] ?? '';
    const value = (pair[2] ?? '').trim();
    if (value === '') {
      fields.set(key, []);
      listKey = key;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      fields.set(key, value.slice(1, -1).split(',').filter((part) => part.trim() !== ''));
      listKey = null;
    } else {
      fields.set(key, value);
      listKey = null;
    }
  }
  return fields;
}

export function parseTaskNote(text: string): AgentTask {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  let body = lines;
  let fields = new Map<string, string | string[]>();
  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1);
    if (end !== -1) {
      fields = readFrontmatter(lines.slice(1, end));
      body = lines.slice(end + 1);
    }
  }
  const mayWrite = fields.get('may_write');
  const every = fields.get('every');
  return {
    mayWrite: (Array.isArray(mayWrite) ? mayWrite : mayWrite === undefined ? [] : [mayWrite])
      .map(cleanFolder)
      .filter((folder) => folder !== ''),
    everyMinutes: parseEvery(typeof every === 'string' ? every : undefined),
    instructions: body.join('\n').trim(),
  };
}

function inside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/** Null when the agent may write `path`, otherwise the reason it may not. */
export function checkWrite(path: string, task: AgentTask): string | null {
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) {
    return `An agent may never write ${path}: the path is not a plain vault path.`;
  }
  const blocked = NEVER.find((folder) => inside(path, folder));
  if (blocked !== undefined) {
    return `An agent may never write in ${blocked}/, whatever its task note says.`;
  }
  if (task.mayWrite.some((folder) => inside(path, folder))) return null;
  return task.mayWrite.length === 0
    ? `${path} is refused: the task note gives this agent no folder to write in.`
    : `${path} is outside ${task.mayWrite.join(', ')}, the folders this agent may write in.`;
}
