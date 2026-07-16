/**
 * Opaque server transport built on Obsidian's `requestUrl()`.
 *
 * It implements the runner's `SyncTransport` against the F2-02/F2-03 endpoints:
 *  - push  → `POST /vaults/:vaultId/revisions`
 *  - pull  → `GET  /vaults/:vaultId/events?after=N`
 *
 * The server is opaque (rule 3): the client only ships pre-built revision
 * envelopes (protected header + base64 payload) and reads back ordered receipts
 * and events. It never asks the server to diff, merge or resolve provenance. All
 * responses are validated defensively — a malformed or non-2xx response raises a
 * transport error so the runner treats the cycle as offline and backs off,
 * rather than advancing its cursor on garbage.
 */

import type {
  PullResult,
  PushReceipt,
  PushRevision,
  RemoteEvent,
  SyncTransport,
} from '../sync/sync-runner';
import type { TransportEnvelope } from './sync-state';

export type { TransportEnvelope };

export interface RequestUrlOptions {
  readonly url: string;
  readonly method: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  /** Always false: we inspect status codes ourselves, never let it throw. */
  readonly throw?: boolean;
}

export interface RequestUrlResponseLike {
  readonly status: number;
  readonly json: unknown;
  /** Raw response body, used for octet-stream blob reads. */
  readonly text?: string;
}

export type RequestUrlFn = (
  options: RequestUrlOptions,
) => Promise<RequestUrlResponseLike>;

export interface RequestUrlTransportOptions {
  readonly requestUrl: RequestUrlFn;
  /** Canonical HTTPS API base, no trailing slash (e.g. `https://host`). */
  readonly apiBaseUrl: string;
  readonly vaultId: string;
  readonly getAuthToken: () => Promise<string>;
  readonly resolveEnvelope: (revisionId: string) => TransportEnvelope | undefined;
  /** Optional server epoch appended to pulls so a restore forces reconciliation. */
  readonly serverEpoch?: () => string | null;
}

export class RequestUrlTransportError extends Error {
  override readonly name = 'RequestUrlTransportError';

  constructor(
    readonly reason: 'unresolved-envelope' | 'http-status' | 'malformed-response',
    message: string,
  ) {
    super(message);
  }
}

export class RequestUrlTransport implements SyncTransport {
  private readonly options: RequestUrlTransportOptions;

  constructor(options: RequestUrlTransportOptions) {
    this.options = options;
  }

  async push(
    revisions: readonly PushRevision[],
  ): Promise<readonly PushReceipt[]> {
    const payload = revisions.map((revision) => {
      const envelope = this.options.resolveEnvelope(revision.revisionId);
      if (envelope === undefined) {
        throw new RequestUrlTransportError(
          'unresolved-envelope',
          `No stored envelope for revision ${revision.revisionId}.`,
        );
      }
      return {
        header: envelope.header,
        idempotencyKey: envelope.idempotencyKey,
        payload: envelope.payloadBase64,
      };
    });

    const response = await this.request({
      method: 'POST',
      url: `${this.options.apiBaseUrl}/vaults/${this.options.vaultId}/revisions`,
      body: JSON.stringify({ revisions: payload }),
    });
    return parsePushResponse(response);
  }

  async pull(after: number): Promise<PullResult> {
    const epoch = this.options.serverEpoch?.() ?? null;
    const query =
      epoch === null
        ? `after=${after}`
        : `after=${after}&epoch=${encodeURIComponent(epoch)}`;
    const response = await this.request({
      method: 'GET',
      url: `${this.options.apiBaseUrl}/vaults/${this.options.vaultId}/events?${query}`,
    });
    return parsePullResponse(response);
  }

  private async request(
    init: Pick<RequestUrlOptions, 'method' | 'url' | 'body'>,
  ): Promise<RequestUrlResponseLike> {
    const token = await this.options.getAuthToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await this.options.requestUrl({
      ...init,
      headers,
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new RequestUrlTransportError(
        'http-status',
        `Server returned HTTP ${response.status}.`,
      );
    }
    return response;
  }
}

function parsePushResponse(
  response: RequestUrlResponseLike,
): readonly PushReceipt[] {
  const body = response.json;
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw malformed('push response missing results array');
  }
  return body.results.map((result): PushReceipt => {
    if (!isRecord(result) || !isRecord(result.receipt)) {
      throw malformed('push result missing receipt');
    }
    const revisionId = result.receipt.revisionId;
    const serverSequence = result.receipt.serverSequence;
    if (
      typeof revisionId !== 'string' ||
      !Number.isSafeInteger(serverSequence) ||
      (serverSequence as number) < 0
    ) {
      throw malformed('push receipt has invalid identity or sequence');
    }
    return { revisionId, serverSequence: serverSequence as number };
  });
}

function parsePullResponse(response: RequestUrlResponseLike): PullResult {
  const body = response.json;
  if (
    !isRecord(body) ||
    !Number.isSafeInteger(body.cursor) ||
    !Array.isArray(body.events)
  ) {
    throw malformed('pull response missing cursor or events');
  }
  const events = body.events.map((raw): RemoteEvent => {
    if (
      !isRecord(raw) ||
      !Number.isSafeInteger(raw.serverSequence) ||
      typeof raw.revisionId !== 'string' ||
      typeof raw.fileId !== 'string' ||
      !isRecord(raw.receipt) ||
      typeof raw.receipt.blobHash !== 'string'
    ) {
      throw malformed('pull event is malformed');
    }
    return {
      serverSequence: raw.serverSequence as number,
      revision: {
        revisionId: raw.revisionId,
        fileId: raw.fileId,
        contentHash: raw.receipt.blobHash,
      },
    };
  });
  return { cursor: body.cursor as number, events };
}

function malformed(detail: string): RequestUrlTransportError {
  return new RequestUrlTransportError('malformed-response', detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
