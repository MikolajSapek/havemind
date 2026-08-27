/**
 * The two ways in (design 1d, plans/007 Phase B).
 *
 * The connect screen used to open with a five-step tutorial that begins "install
 * Tailscale" and "set up your own server". About half of all users are joining a
 * vault someone else hosts and need only paste an invitation, they read that
 * wall, concluded they had to run Docker, and left. This is the costliest defect
 * in the product: it loses people before any feature is reachable.
 *
 * The fix is a chooser, and the discriminator is deliberately **a possession,
 * not an intention**: "someone sent you a long block of text" is a fact the user
 * can check, where "do you want to self-host?" is a question they cannot answer
 * before understanding the product. Each row states its own cost in time and
 * tools, so the expensive pick is visibly expensive before it is made.
 *
 * Pure content, no DOM, no Obsidian import, so the wording stays testable.
 */

/** Which entry path the user picked, or none yet. */
export type EntryChoice = 'undecided' | 'joining' | 'hosting';

export interface EntryOption {
  readonly id: Exclude<EntryChoice, 'undecided'>;
  readonly title: string;
  /** What it costs: time, and what you need to hand. */
  readonly cost: string;
}

export interface EntryChooserViewModel {
  readonly heading: string;
  readonly subheading: string;
  readonly question: string;
  readonly options: readonly EntryOption[];
  /** Rescues anyone still unsure, so the chooser is never a dead end. */
  readonly footnote: string;
}

export function buildEntryChooser(): EntryChooserViewModel {
  return {
    heading: 'Havemind',
    subheading: 'One shared vault, on your hardware.',
    question: 'Two or three people, one server you run. Which are you?',
    options: [
      {
        id: 'joining',
        title: 'Someone sent me an invitation',
        cost: 'Paste it, read out six digits, done. About a minute.',
      },
      {
        id: 'hosting',
        title: "I'll run the server",
        cost:
          'Docker and Tailscale on a machine that stays on. Fifteen minutes, a terminal.',
      },
    ],
    footnote:
      "Not sure? If a friend sent you a long block of text, it's the first one.",
  };
}

/** The host path's steps, shown only to the person they were written for. */
export interface HostStep {
  readonly text: string;
  /** Shell to run, rendered as a copyable block. */
  readonly command?: string;
}

export interface HostViewModel {
  readonly heading: string;
  readonly subheading: string;
  readonly steps: readonly HostStep[];
  readonly guideLabel: string;
  readonly guideUrl: string;
  readonly primaryAction: string;
}

export const SELF_HOSTING_GUIDE_URL =
  'https://github.com/MikolajSapek/havemind/blob/main/docs/self-hosting.md';

export function buildHostView(): HostViewModel {
  return {
    heading: 'Run the server',
    subheading: 'On a machine that stays awake and is on your private network.',
    steps: [
      { text: 'Install Docker and Tailscale on that machine.' },
      { text: 'Sign both machines into the same tailnet.' },
      { text: 'Run the stack:', command: 'docker compose up -d' },
      { text: "Copy its Tailscale address, that's your server URL." },
      { text: 'Connect below, then invite the others.' },
    ],
    guideLabel: 'Full self-hosting guide',
    guideUrl: SELF_HOSTING_GUIDE_URL,
    primaryAction: "I've done this, connect",
  };
}
