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
  PushItemResult,
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

  /** True on HTTP 401 — the session was refused; the loop must stop, not retry. */
  readonly authDenied: boolean;

  /**
   * True on a whole-request 4xx the same bytes will never satisfy (400 bad
   * request, 413 payload too large, 422 invalid batch). The runner quarantines
   * the offending revision instead of retrying it forever. 5xx and network
   * failures stay transient (this is false) and keep the retry-with-backoff path.
   */
  readonly permanent: boolean;

  constructor(
    readonly reason: 'unresolved-envelope' | 'http-status' | 'malformed-response',
    message: string,
    options?: { authDenied?: boolean; permanent?: boolean },
  ) {
    super(message);
    this.authDenied = options?.authDenied ?? false;
    this.permanent = options?.permanent ?? false;
  }
}

/**
 * Server error codes (returned per revision on a 200, or as the whole-request
 * error code) that will never be satisfied by re-sending the identical bytes, so
 * the runner dead-letters them. HEAD_SET_CHANGED and MISSING_PARENT are
 * deliberately excluded — they are retryable once the client pulls the newer
 * head or the missing parent lands, so they stay in the outbox.
 */
const PERMANENT_SYNC_CODES: ReadonlySet<string> = new Set([
  'INVALID_REQUEST',
  'INVALID_BATCH',
  'FORBIDDEN',
  'REVISION_ID_REUSE',
  'CONFLICT',
  'NOT_FOUND',
]);

function isPermanentSyncCode(code: unknown): boolean {
  return typeof code === 'string' && PERMANENT_SYNC_CODES.has(code);
}

/** Whole-request HTTP statuses that will never succeed on a blind retry. */
function isPermanentStatus(status: number): boolean {
  return status === 400 || status === 413 || status === 422;
}

export class RequestUrlTransport implements SyncTransport {
  private readonly options: RequestUrlTransportOptions;

  constructor(options: RequestUrlTransportOptions) {
    this.options = options;
  }

  async push(
    revisions: readonly PushRevision[],
  ): Promise<readonly PushItemResult[]> {
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
        {
          authDenied: response.status === 401,
          permanent: isPermanentStatus(response.status),
        },
      );
    }
    return response;
  }
}

function parsePushResponse(
  response: RequestUrlResponseLike,
): readonly PushItemResult[] {
  const body = response.json;
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw malformed('push response missing results array');
  }
  return body.results.map((result): PushItemResult => {
    if (!isRecord(result) || typeof result.revisionId !== 'string') {
      throw malformed('push result missing revisionId');
    }
    // A per-revision rejection carries a machine code but no receipt; classify
    // it so the runner quarantines permanent failures and retries transient ones.
    if (result.status === 'rejected') {
      return {
        revisionId: result.revisionId,
        outcome: 'rejected',
        permanent: isPermanentSyncCode(result.code),
      };
    }
    if (!isRecord(result.receipt)) {
      throw malformed('push result missing receipt');
    }
    const receiptRevisionId = result.receipt.revisionId;
    const serverSequence = result.receipt.serverSequence;
    if (
      typeof receiptRevisionId !== 'string' ||
      !Number.isSafeInteger(serverSequence) ||
      (serverSequence as number) < 0
    ) {
      throw malformed('push receipt has invalid identity or sequence');
    }
    return {
      revisionId: result.revisionId,
      outcome: 'accepted',
      receipt: {
        revisionId: receiptRevisionId,
        serverSequence: serverSequence as number,
      },
    };
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
