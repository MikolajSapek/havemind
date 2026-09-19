/**
 * Typed access to the plugin's private members, for tests.
 *
 * The lifecycle tests drive `main.ts` from the inside: they pin a connection
 * handle mid-flight, fire a status transition, or assert a timer was cleared.
 * Those members are private, so every call site used `internals(plugin).x` and
 * carried an `eslint-disable` for `no-explicit-any`. That was 114 disables
 * across six files, one per line, all saying the same thing.
 *
 * `internals(plugin)` says it once. Each member is named and typed here, so a
 * test that reaches for something the plugin no longer has fails to compile
 * instead of silently reading `undefined` through `any`.
 */

import type HavemindPlugin from '../main';

/** The private surface the lifecycle tests drive. Widen as tests need it. */
export interface PluginInternals {
  activityLog: { record(entry: unknown): void; snapshot(): unknown[] };
  activityOptions: Record<string, unknown>;
  connection: unknown;
  connectionError: unknown;
  connectionPanel(): unknown;
  connectionStatus: string;
  deadMembershipIds: string[];
  handleStatus(status: string, view?: unknown): void;
  loadData(): Promise<unknown>;
  loadRoster(): Promise<void>;
  pendingApprovals: unknown;
  pollRejoinOnce(): Promise<void>;
  recordRosterMember(member: unknown): Promise<void>;
  rejoinController: unknown;
  rejoinPollTimer: unknown;
  rejoinWaiting: Set<string>;
  resetConnection(): unknown;
  retryConnection(): Promise<void>;
  rosterMembers: unknown[];
  saveData(data: unknown): Promise<void>;
  startConnection(): Promise<void>;
}

/**
 * Reads the plugin as its private surface. One cast, declared once, instead of
 * an `any` and a lint suppression at every call site.
 */
export function internals(plugin: HavemindPlugin): PluginInternals {
  return plugin as unknown as PluginInternals;
}
