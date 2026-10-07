/**
 * Initials for the flower's seats.
 *
 * Every member's seat has the same colour, so the initials are what tell people
 * apart. They must therefore be unique within a vault: two "MS" seats would make
 * the flower lie about who is who. Pure, no DOM.
 */

/** The words of a name, keeping letters only (any script, diacritics included). */
function letterWords(name: string): string[] {
  return name
    .split(/\s+/)
    .map((word) => Array.from(word).filter((ch) => /\p{L}/u.test(ch)).join(''))
    .filter((word) => word.length > 0);
}

/** "Mikołaj Sapek" → "MS", "Hubert" → "H", nothing usable → "?". */
export function initialsFor(name: string): string {
  const words = letterWords(name);
  if (words.length === 0) return '?';
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toLocaleUpperCase() ?? '')
    .join('');
}

/** "Mikołaj" → "Mi": the fallback when plain initials collide. */
function twoLetters(name: string): string {
  const first = letterWords(name)[0];
  if (first === undefined) return '?';
  const [head = '', second = ''] = Array.from(first);
  return head.toLocaleUpperCase() + second.toLocaleLowerCase();
}

export interface NamedMember {
  readonly id: string;
  readonly name: string;
}

function groupBy(
  members: readonly NamedMember[],
  key: (member: NamedMember) => string,
): Map<string, NamedMember[]> {
  const groups = new Map<string, NamedMember[]>();
  for (const member of members) {
    const value = key(member);
    groups.set(value, [...(groups.get(value) ?? []), member]);
  }
  return groups;
}

/**
 * Unique initials per member id. Collisions fall back to two letters of the
 * first word, and anything still colliding is numbered in input order.
 */
export function assignInitials(
  members: readonly NamedMember[],
): Map<string, string> {
  const result = new Map<string, string>();
  const pending: NamedMember[] = [];
  for (const [label, group] of groupBy(members, (m) => initialsFor(m.name))) {
    if (group.length === 1 && group[0] !== undefined) result.set(group[0].id, label);
    else pending.push(...group);
  }
  for (const [label, group] of groupBy(pending, (m) => twoLetters(m.name))) {
    if (group.length === 1 && group[0] !== undefined) {
      result.set(group[0].id, label);
      continue;
    }
    const base = Array.from(label)[0] ?? '?';
    group.forEach((member, index) => result.set(member.id, `${base}${index + 1}`));
  }
  return result;
}
