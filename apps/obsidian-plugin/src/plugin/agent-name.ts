/**
 * An agent's name becomes a file name (Havemind/Agents/<name>.md), so it is
 * checked before it goes anywhere near a path: letters, digits, spaces, dots,
 * dashes and underscores, 1 to 40 of them, never a leading dot. Unicode letters
 * are allowed so names like "Zażółć" work; none of the allowed characters can
 * climb out of the folder.
 */

const AGENT_NAME = /^[\p{L}\p{N}_ .-]{1,40}$/u;

/** Null when the name is fine; otherwise the sentence to show the owner. */
export function agentNameProblem(name: string): string | null {
  if (AGENT_NAME.test(name) && !name.startsWith('.')) return null;
  return 'Use 1 to 40 letters, digits, spaces, dots, dashes or underscores for the agent name, and do not start with a dot.';
}
