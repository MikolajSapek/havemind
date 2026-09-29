/**
 * The runtime `App`'s Vault shape (Obsidian's ambient stub models only the
 * surface we use), which every adapter module needs but none of them owns.
 * Kept in its own leaf module so no adapter has to import a sibling, or the
 * `obsidian-adapters.ts` façade, just to reach it, which is what keeps the
 * adapter graph acyclic.
 */

import type { Vault } from 'obsidian';

/** The runtime App exposes a Vault; the ambient stub only models what we use. */
export type AppWithVault = { vault: Vault };
