/**
 * View-model for the in-plugin "Getting started" tutorial shown in the panel's
 * disconnected/empty state (and re-openable from a small help affordance once
 * connected).
 *
 * This module stays pure — it returns the numbered steps as data so the desktop
 * shell can render them with the existing panel helpers without the DOM, and so
 * the wording, ordering and doc link stay unit-testable. It invents no backend
 * calls or settings: every step maps onto the connect flow the panel already
 * exposes.
 */

/**
 * Absolute URL to the self-hosting guide referenced by the tutorial. Must be
 * absolute (scheme + host), not a repo-relative path: Obsidian's desktop shell
 * resolves an `<a href>` against its own internal origin, not GitHub, so a bare
 * `docs/self-hosting.md` silently fails to navigate anywhere on click.
 */
export const SELF_HOSTING_DOC_PATH =
  'https://github.com/MikolajSapek/havemind/blob/main/docs/self-hosting.md';

/** A documentation reference rendered as an inline link after a step. */
export interface GettingStartedDocRef {
  /** Short human-readable link label (no URL, no emoji). */
  readonly label: string;
  /** Target of the link — the in-repo doc path. */
  readonly url: string;
}

/** One numbered, single-line, imperative tutorial step. */
export interface GettingStartedStep {
  /** 1-based position, rendered as the accent number badge. */
  readonly number: number;
  /** Single short imperative line. */
  readonly text: string;
  /** Optional inline documentation link appended after the text. */
  readonly docRef?: GettingStartedDocRef;
}

/** The whole tutorial: a title, the ordered steps, and a closing footnote. */
export interface GettingStartedViewModel {
  readonly title: string;
  /**
   * Up-front, unmissable statement that Havemind is not a cloud service and
   * cannot work without a self-hosted server on the user's Tailscale network.
   */
  readonly requirement: string;
  readonly steps: readonly GettingStartedStep[];
  readonly footnote: string;
}

/**
 * Builds the static "Getting started" tutorial. Content only — action-first,
 * one line per step, no filler. Step 2 carries the self-hosting doc link; the
 * footnote points newcomers at the README and the same guide for the two things
 * that happen outside this panel (installing the plugin, running a server).
 */
export function buildGettingStartedViewModel(): GettingStartedViewModel {
  return {
    title: 'Getting started',
    requirement:
      'Havemind needs a self-hosted server on your Tailscale network — there is no cloud. Connect to one you were given, or run your own.',
    steps: [
      {
        number: 1,
        text: 'Install and connect Tailscale, and make sure it shows connected.',
      },
      {
        number: 2,
        text:
          'Get your Server URL and a pairing token from whoever runs your Havemind server, or set up your own.',
        docRef: { label: 'Self-hosting guide', url: SELF_HOSTING_DOC_PATH },
      },
      {
        number: 3,
        text: 'Paste the Server URL and pairing token below, then select Connect.',
      },
      {
        number: 4,
        text:
          "Joining someone's vault? Read the 6-digit code aloud to the owner so they can approve you.",
      },
      {
        number: 5,
        text:
          'Done — your edits sync to the other devices in about a second. Use a dedicated vault, and don\'t run another sync tool on it.',
      },
    ],
    footnote:
      'New here? Installing the plugin and running a server are covered in the project README and docs/self-hosting.md.',
  };
}
