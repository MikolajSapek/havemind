/**
 * The two pre-rendered status-bar views the connect path reports without ever
 * running a sync cycle: nothing paired, and a stored pairing that is broken
 * beyond retrying. Both are computed once from `formatStatusBar` so the terminal
 * states share exactly one rendering with every live status the controller emits.
 */

import { formatStatusBar } from '../status';

export const HAVEMIND_STATUS_DISCONNECTED = formatStatusBar({
  status: 'disconnected',
});

/** Status-bar view for the terminal "stored connection is broken" state (P1 #5). */
export const HAVEMIND_STATUS_RESET_REQUIRED = formatStatusBar({
  status: 'reset-required',
});
