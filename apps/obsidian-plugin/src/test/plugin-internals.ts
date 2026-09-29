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
import type { ConflictResolveModal } from '../ui/conflict-modal';

/** The private surface the lifecycle tests drive. Widen as tests need it. */
export interface PluginInternals {
  activityLog: { record(entry: unknown): void; snapshot(): unknown[] };
  connection: unknown;
  connectionActive: boolean;
  connectionError: unknown;
  connectionPanel(): unknown;
  connectionStatus: string;
  handleStatus(status: string, view?: unknown, detail?: string): void;
  loadData(): Promise<unknown>;
  loadRoster(): Promise<void>;
  openConflictModal(copyPath: string): Promise<ConflictResolveModal | null>;
  pendingApprovals: unknown;
  pendingInvitation: unknown;
  pollRejoinOnce(): Promise<void>;
  recordRosterMember(member: unknown): Promise<void>;
  rejoinController: unknown;
  rejoinPollTimer: unknown;
  rejoinWaiting: Set<string>;
  removeMember(membershipId: string): Promise<void>;
  requestRejoin(membershipId: string): Promise<void>;
  resetConnection(): unknown;
  disconnect(): void;
  dismissInvitation(): void;
  retryConnection(): Promise<void>;
  rosterMembers: unknown[];
  saveData(data: unknown): Promise<void>;
  startConnection(): Promise<void>;
  syncState: unknown;
  sendQueueView(): unknown;
  retrySend(revisionId: string): Promise<void>;
  discardSend(revisionId: string): Promise<void>;
  refreshLastEdited(): Promise<void>;
}

/** The plugin fields holding the modules under `plugin/` that members moved into. */
const MODULES = ['conflicts', 'invitations', 'people', 'sendQueue'];

/**
 * Reads the plugin as its private surface. One cast, declared once, instead of
 * an `any` and a lint suppression at every call site. A member the plugin no
 * longer has is found on the module it moved into, and methods come back bound
 * to their owner, so `this` is never the proxy.
 */
export function internals(plugin: HavemindPlugin): PluginInternals {
  const fields = plugin as unknown as Record<string, object>;
  const owner = (key: string | symbol): object =>
    key in plugin
      ? plugin
      : (MODULES.map((name) => fields[name] as object).find((module) => key in module) ?? plugin);
  return new Proxy(plugin, {
    get: (_plugin, key) => {
      const holder = owner(key);
      const value: unknown = Reflect.get(holder, key);
      return typeof value === 'function' ? value.bind(holder) : value;
    },
    set: (_plugin, key, value) => Reflect.set(owner(key), key, value),
  }) as unknown as PluginInternals;
}
