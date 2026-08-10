/**
 * The two platform-glue internals every adapter module needs but none of them
 * owns: the runtime `App`'s Vault shape (Obsidian's ambient stub models only the
 * surface we use) and the plain-record guard that validates untrusted
 * plugin-data blobs before they are read. Kept in its own leaf module so no
 * adapter has to import a sibling — or the `obsidian-adapters.ts` façade — just
 * to reach them, which is what keeps the adapter graph acyclic.
 */

import type { Vault } from 'obsidian';

/** The runtime App exposes a Vault; the ambient stub only models what we use. */
export type AppWithVault = { vault: Vault };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
