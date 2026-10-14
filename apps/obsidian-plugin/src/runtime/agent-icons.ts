/**
 * Pixel icons for AI agents (plan 016): one 12×12 drawing per ready-made
 * agent, "#" a filled pixel. Drawn as crisp SVG squares in the theme's ink on
 * the agent yellow, wherever an agent is named: the Add agent tiles, its
 * People row, its flower seat and its Activity rows.
 *
 * Which icon an agent wears is written in its task note (`icon: <id>`), so
 * people can change it like any note; the server never knows.
 */

export const ICON_SIZE = 12;

export const AGENT_ICONS: Readonly<Record<string, readonly string[]>> = {
  'inbox-sorter': [
    '.....##.....',
    '.....##.....',
    '.....##.....',
    '...######...',
    '....####....',
    '.....##.....',
    '............',
    '#..........#',
    '#..........#',
    '#...####...#',
    '#..........#',
    '############',
  ],
  'daily-summary': [
    '..#......#..',
    '############',
    '#..........#',
    '############',
    '#..........#',
    '#.##.##.##.#',
    '#..........#',
    '#.##.##.##.#',
    '#..........#',
    '#.##.##....#',
    '#..........#',
    '############',
  ],
  'link-gardener': [
    '.......###..',
    '......#####.',
    '.##...####..',
    '####..##....',
    '.####.#.....',
    '..###.#.....',
    '....###.....',
    '.....#......',
    '.....#......',
    '..########..',
    '...######...',
    '...######...',
  ],
  'meeting-to-tasks': [
    '############',
    '#..........#',
    '#.##.#####.#',
    '#.##.......#',
    '#..........#',
    '#.##.#####.#',
    '#.##.......#',
    '#..........#',
    '#.##.#####.#',
    '#.##.......#',
    '#..........#',
    '############',
  ],
  'clip-digester': [
    '.#........#.',
    '.##......##.',
    '..##....##..',
    '...##..##...',
    '....####....',
    '.....##.....',
    '....####....',
    '..###..###..',
    '.#..#..#..#.',
    '.#..#..#..#.',
    '..##....##..',
    '............',
  ],
  robot: [
    '.....##.....',
    '.....##.....',
    '..########..',
    '.#........#.',
    '.#.##..##.#.',
    '.#.##..##.#.',
    '.#........#.',
    '.#..####..#.',
    '.#........#.',
    '..########..',
    '...#....#...',
    '..##....##..',
  ],
};

export const DEFAULT_AGENT_ICON = 'robot';

/** The icon a task note names (`icon: <id>`), or the robot. */
export function iconForTaskNote(text: string | null): string {
  const match = text === null ? null : /^icon:\s*([a-z-]+)\s*$/mu.exec(text.split(/^---\s*$/mu)[1] ?? '');
  const id = match?.[1];
  return id !== undefined && AGENT_ICONS[id] !== undefined ? id : DEFAULT_AGENT_ICON;
}

/** The filled pixels of an icon, as [x, y] pairs. */
export function iconPixels(id: string): readonly (readonly [number, number])[] {
  const rows = AGENT_ICONS[id] ?? AGENT_ICONS[DEFAULT_AGENT_ICON] ?? [];
  const pixels: [number, number][] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) if (row[x] === '#') pixels.push([x, y]);
  });
  return pixels;
}
