import { decodeRevisionPayload, type DecodedRevisionPayload } from '@havemind/sync-core';
import type { RemoteEvent, SyncTransport } from '../sync/sync-runner';
import type { DurableSyncState } from './sync-state';

/** A revision-bound view of ancestry, reconstructed from the append-only event log.
 * Payloads are fetched lazily and verified by the connection resolver. No server
 * schema change or retained, unversioned "last common text" is needed.
 */
export class RevisionHistory {
  private readonly accepted = new Map<string, RemoteEvent>();
  private readonly payloads = new Map<string, DecodedRevisionPayload>();
  private cursor = 0;
  private loaded = false;
  private loading: Promise<void> | null = null;

  constructor(private readonly options: {
    transport: Pick<SyncTransport, 'pull'>;
    resolveRevision: (event: RemoteEvent) => Promise<DecodedRevisionPayload>;
    state: DurableSyncState;
  }) {}

  async refresh(): Promise<void> {
    if (this.loading !== null) return this.loading;
    const load = async (): Promise<void> => {
      let target: number | null = null;
      do {
        const page = await this.options.transport.pull(this.cursor);
        target ??= page.cursor;
        for (const event of page.events) {
          if (event.serverSequence <= this.cursor) continue;
          if (event.serverSequence !== this.cursor + 1) throw new Error('Revision history has a gap.');
          this.accepted.set(event.revision.revisionId, event);
          this.cursor = event.serverSequence;
        }
        if (page.events.length === 0 && this.cursor < target) throw new Error('Revision history is incomplete.');
      } while (this.cursor < target);
    };
    this.loading = load();
    try { await this.loading; this.loaded = true; } finally { this.loading = null; }
  }

  async graph(fileId: string): Promise<Map<string, RemoteEvent>> {
    if (!this.loaded) await this.refresh();
    const graph = new Map([...this.accepted].filter(([, event]) => event.revision.fileId === fileId));
    for (const queued of await this.options.state.listOutbox()) {
      if (queued.fileId !== fileId || graph.has(queued.revisionId)) continue;
      graph.set(queued.revisionId, { serverSequence: 0, revision: queued });
    }
    return graph;
  }

  /** A pull can receive a revision committed after the cycle snapshot. */
  async ensureEvent(event: RemoteEvent): Promise<void> {
    if (!this.accepted.has(event.revision.revisionId)) await this.refresh();
    if (!this.accepted.has(event.revision.revisionId)) throw new Error('Incoming revision is missing from history.');
  }

  async allHeads(): Promise<RemoteEvent[]> {
    if (!this.loaded) await this.refresh();
    const parents = new Set([...this.accepted.values()].flatMap((e) => e.revision.parentRevisionIds ?? []));
    return [...this.accepted.values()].filter((e) => !parents.has(e.revision.revisionId));
  }

  async heads(fileId: string): Promise<RemoteEvent[]> {
    if (!this.loaded) await this.refresh();
    const events = [...this.accepted.values()].filter((event) => event.revision.fileId === fileId);
    const parents = new Set(events.flatMap((event) => event.revision.parentRevisionIds ?? []));
    return events.filter((event) => !parents.has(event.revision.revisionId));
  }

  async payload(event: RemoteEvent): Promise<DecodedRevisionPayload> {
    const id = event.revision.revisionId;
    const cached = this.payloads.get(id);
    if (cached !== undefined) return cached;
    const queued = await this.options.state.getEnvelope(id);
    const payload = queued === undefined
      ? await this.options.resolveRevision(event)
      : decodeRevisionPayload(Uint8Array.from(atob(queued.payloadBase64), (char) => char.charCodeAt(0)));
    this.payloads.set(id, payload);
    return payload;
  }
}

export function ancestors(graph: ReadonlyMap<string, RemoteEvent>, start: string): Set<string> {
  const result = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.pop() as string;
    if (result.has(id)) continue;
    result.add(id);
    queue.push(...(graph.get(id)?.revision.parentRevisionIds ?? []));
  }
  return result;
}

/** Multiple incomparable common ancestors need a virtual merge; fail closed. */
export function commonAncestor(graph: ReadonlyMap<string, RemoteEvent>, left: string, right: string): RemoteEvent | null {
  const leftAncestors = ancestors(graph, left);
  const common = [...ancestors(graph, right)].filter((id) => leftAncestors.has(id) && graph.has(id));
  const commonSet = new Set(common);
  const superseded = new Set(common.flatMap((id) => graph.get(id)?.revision.parentRevisionIds ?? []).filter((id) => commonSet.has(id)));
  const nearest = common.filter((id) => !superseded.has(id));
  return nearest.length === 1 ? graph.get(nearest[0] as string) ?? null : null;
}
