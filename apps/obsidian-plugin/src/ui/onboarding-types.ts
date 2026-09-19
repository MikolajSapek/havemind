/**
 * The onboarding pane's public types: the models it renders and the options bag
 * the plugin injects.
 *
 * Split out of `onboarding-view.ts` for Stage 3. Types have no reason to sit in
 * the same file as the DOM that draws them, and moving them is what lets the
 * view be read as a dispatcher. `onboarding-view.ts` re-exports every name, so
 * nothing that imported them has to change.
 */

import type { RevisionRecord } from '../activity/activity';
import type { ConflictCopy } from '../runtime/conflict-resolution';
import type { CreatedInvitation } from '../runtime/create-invitation';
import type { RejoinRosterView } from '../runtime/rejoin-roster';
import type { MemberRole } from '../runtime/roster';
import type { SendQueueStatusView } from '../runtime/send-queue-status';
import type { ConnectionPanelView } from '../runtime/status';

/** Report a human-readable connect-flow state back to the onboarding view. */
export type ConnectReporter = (message: string) => void;

/** A device the owner minted an invitation for and can now approve. */
export interface PendingApprovalEntry {
  /** Server-issued invitation id (a UUID, not a secret). */
  readonly invitationId: string;
  /** ISO-8601 expiry of the invitation. */
  readonly expiresAt: string;
  /** Name the owner gave the intended member (e.g. "Magda"), if any. */
  readonly intendedMemberDisplayName?: string;
  /** Role the invitation was minted for; carried into the roster on approval. */
  readonly intendedRole?: MemberRole;
}

/** The invitee role the owner mints an invitation for. */
export type InvitationRole = 'editor' | 'owner';

/**
 * Single-panel model for the owner "Create connection" surface: the create
 * section (role + name + last-minted envelope) and the live waiting section
 * (devices awaiting approval) live together and never tear each other down.
 */
export interface CreateConnectionViewModel {
  /** Default role for the select on first render. */
  readonly role: InvitationRole;
  /** Default intended-member name for the input on first render. */
  readonly name: string;
  /** The most recently minted invitation, shown with a Copy button. */
  readonly invitation: CreatedInvitation | null;
  /** Devices waiting for the owner to approve them. */
  readonly pending: readonly PendingApprovalEntry[];
  /** True once the minted invitation is past its expiry (single-use, ~15 min). */
  readonly invitationExpired?: boolean;
  /** Transient confirmation line (e.g. "Invitation created."), if any. */
  readonly notice?: string;
  /**
   * Visual treatment for `notice`. 'success' renders the icon+label+colour
   * status-row convention (never colour alone); omitted/'info' renders the
   * plain text line used for routine progress messages.
   */
  readonly noticeKind?: 'info' | 'success';
}

/**
 * Durable guest-side state while waiting for the owner to approve this device.
 * Held in plugin state (not the ephemeral status line) so closing and reopening
 * the pane resumes the waiting screen instead of drawing a blank paste form,
 * which would tempt the guest into re-pasting a single-use invitation.
 */
export interface GuestWaitingViewModel {
  /** The phrase this device must read aloud to the owner. */
  readonly verificationPhrase: string;
  /**
   * Who invited them, when known. Naming the other person turns an instruction
   * into a conversation, "read these to Mira" beats "read these to the vault
   * owner" (design 1e). An unnamed owner is still a valid state.
   */
  readonly ownerName?: string;
}

/** Injected data + actions for the onboarding surface. */
export interface OnboardingViewOptions {
  /** Releases the plugin's active-view reference when Obsidian closes this leaf. */
  readonly onClosed?: () => void;
  /**
   * Whether this device can plausibly run the server. The plugin passes
   * `!Platform.isMobileApp`: hosting needs Docker, a terminal and a machine
   * that stays awake, so on a phone the entry chooser drops to joining only.
   * Injected rather than read from `Platform` here so the view stays testable
   * without a platform global. Defaults to true.
   */
  readonly canHost?: boolean;
  /**
   * The revision feed, rendered as a collapsed section of this pane rather
   * than a separate destination (plans/007 Stage 0). Reads the same provider
   * the standalone Activity view uses, so the two cannot disagree.
   */
  readonly activityFeedProvider?: () => readonly RevisionRecord[];
  /** Current author-overlay state, for the footer toggle. */
  readonly authorOverlayProvider?: () => boolean;
  /** Flips the author overlay from the footer (the toggle lost its ribbon icon). */
  readonly onToggleAuthorOverlay?: () => void;
  /** Opens the owner's invite composer from the action bar. */
  readonly onOpenComposer?: () => void;
  /** Closes the owner's invite composer and returns to the People tab. */
  readonly onCloseComposer?: () => void;
  /** Forces a sync cycle from the action bar, matching the `sync-now` command. */
  readonly onSyncNow?: () => void;
  /**
   * True when the user reached the pane through an `obsidian://havemind-join`
   * link. That click already answers the entry chooser, they hold an
   * invitation, so the question is skipped (design 1d).
   */
  readonly arrivedWithInvitationProvider?: () => boolean;
  /** Restores a revision from an activity row. */
  readonly onRestore?: (revisionId: string) => void;
  /**
   * Owner "Create connection" composer model; when it returns non-null the
   * unified create + approve panel is shown instead of the guest connect
   * surfaces. Both sections render together so approving never unmounts create.
   */
  readonly composerProvider?: () => CreateConnectionViewModel | null;
  /**
   * Guest-side waiting model; when it returns non-null the "waiting for the
   * owner to approve" screen is shown (carrying the verification phrase) instead
   * of the paste form, so a pane reopen resumes the wait rather than re-prompting.
   */
  readonly guestWaitingProvider?: () => GuestWaitingViewModel | null;
  /**
   * When it returns true the guest sees a terminal "invitation no longer valid"
   * screen (with the paste form to try a fresh invite). Set after a server
   * rejection/lockout so the waiting screen is never left offline or blank.
   */
  readonly guestInvalidProvider?: () => boolean;
  /** Live connection indicator model; defaults to the disconnected panel. */
  readonly panelProvider?: () => ConnectionPanelView;
  /**
   * MRG-03 conflict copies awaiting resolution. When it returns a non-empty
   * list the "Conflicts" section is drawn in the panel; an empty list (or an
   * omitted provider) hides it entirely.
   */
  readonly conflictsProvider?: () => readonly ConflictCopy[];
  /** Open the resolve modal for the conflict copy at this vault path. */
  readonly onResolveConflict?: (copyPath: string) => void;
  /**
   * SND-01 send-queue status. When it returns a view with a waiting count or
   * any failed items the "waiting/failed to send" section is drawn beneath the
   * status indicator; null (disconnected) or an all-clear view draws nothing.
   */
  readonly sendQueueProvider?: () => SendQueueStatusView | null;
  /**
   * GAP-1 recovery signal. Returns true when the durable sync state could not
   * read its persisted outbox and resumed from a clean empty state, the panel
   * then draws a "local queue needs recovery" warning so the loss is never
   * silent. Defaults to false (nothing to recover) when omitted.
   */
  readonly recoveryRequiredProvider?: () => boolean;
  /** Retry a quarantined send: re-enqueue it through the outbox machinery. */
  readonly onRetrySend?: (revisionId: string) => void;
  /** Discard a quarantined send permanently (panel confirms in two steps). */
  readonly onDiscardSend?: (revisionId: string) => void;
  /**
   * Presence roster (who is connected) with the F9 rejoin affordance. Rendered
   * in the owner composer and in the connected panel so both the owner and the
   * invitee see a clear "Connected" list. Presence is persistent connection
   * state, never activity; a known-dead contact is drawn as disconnected with a
   * Rejoin button.
   */
  readonly rejoinRosterProvider?: () => RejoinRosterView;
  /** Membership ids the owner has asked to rejoin (awaiting reconnect). */
  readonly rejoinWaitingProvider?: () => ReadonlySet<string>;
  /** Owner clicked Rejoin on a disconnected contact, issue the rejoin grant. */
  readonly onRejoin?: (membershipId: string) => void;
  /** Owner marks a connected contact disconnected, arming its Rejoin button. */
  readonly onMarkDisconnected?: (membershipId: string) => void;
  /** Owner permanently removes a member from the vault (two-step confirm in UI). */
  readonly onRemove?: (membershipId: string) => void;
  /**
   * Runs the connect flow for the pasted input (invitation envelope `v1.…` or
   * owner pairing token `hm_pt_…`) against the given server URL, reporting
   * progress messages back to the view.
   */
  readonly onConnect?: (
    input: string,
    serverUrl: string,
    report: ConnectReporter,
  ) => void;
  /** Stop the live sync loop so the paste form returns. */
  readonly onDisconnect?: () => void;
  /**
   * Force an immediate reconnect from a non-synced backoff/terminal state
   * (offline or reconnect-required), instead of waiting out the sync runner's
   * backoff. Rendered as the "Retry now" button in the status section.
   */
  readonly onRetry?: () => void;
  /**
   * Clear the broken persisted connection so this device can be paired again
   * (P1 #5). Rendered as the "Reset connection" button, and ONLY in the
   * `reset-required` state, a state in which sync is provably dead, so the
   * button can never be mistaken for an action on a healthy connection.
   */
  readonly onReset?: () => void;
  /** Copy the rendered invitation envelope to the clipboard (never logged). */
  readonly onCopyInvitation?: (envelope: string) => boolean | Promise<boolean>;
  /** Mint an invitation for the given role and intended-member name. */
  readonly onCreateInvitation?: (
    role: InvitationRole,
    name: string,
    report: ConnectReporter,
  ) => void;
  /** Dismiss the minted-invitation display (clears the dead-end envelope). */
  readonly onDismissInvitation?: () => void;
  /** Approve the joining device that read out the given verification phrase. */
  readonly onApprove?: (
    invitationId: string,
    verificationPhrase: string,
    report: ConnectReporter,
  ) => void;
}
