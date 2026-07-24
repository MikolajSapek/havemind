/**
 * Regression guard for the owner-connect path: once `POST /owner/pair` has
 * succeeded and the refresh token + owner connection are persisted, NO
 * best-effort follow-up step (the one-time canonicalization rebase, the push
 * producer, or the real-time push subscription) may discard the established
 * session by throwing. A genuine pre-pair failure (a 4xx from the server) must
 * still surface as a null connect so real failures are never masked.
 *
 * These drive `connectFromInput` end to end through the real `startSyncLoop`,
 * which the higher-level lifecycle tests only ever exercise against a mocked
 * `connectFromInput` — so this is the first coverage of the assembly itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequestUrl = vi.fn();

vi.mock('obsidian', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, requestUrl: mockRequestUrl };
});

const REBASE_MARKER_KEY = 'canonicalizationRebaseVersion';

class FakeSecretStorage {
  private readonly map = new Map<string, string>();
  getSecret(id: string): string | null {
    return this.map.get(id) ?? null;
  }
  listSecrets(): string[] {
    return [...this.map.keys()];
  }
  setSecret(id: string, secret: string): void {
    this.map.set(id, secret);
  }
}

/** Minimal vault double: an empty vault with an injectable listener hook. */
class FakeVault {
  constructor(private readonly onListener: () => void = () => undefined) {}
  getAbstractFileByPath(): unknown {
    return null;
  }
  getFiles(): { path: string }[] {
    return [];
  }
  async read(): Promise<string> {
    return '';
  }
  async readBinary(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }
  on(): { unsubscribe: () => void } {
    this.onListener();
    return { unsubscribe: () => undefined };
  }
  offref(): void {}
}

class FakeWorkspace {
  getLeavesOfType(): unknown[] {
    return [];
  }
  onLayoutReady(cb: () => void): void {
    cb();
  }
}

interface PluginOptions {
  readonly failMarkerSave?: boolean;
  readonly failListenerRegistration?: boolean;
}

function makePlugin(options: PluginOptions = {}) {
  let data: Record<string, unknown> = {};
  const vault = new FakeVault(() => {
    if (options.failListenerRegistration === true) {
      throw new Error('vault.on exploded during listener registration');
    }
  });
  return {
    app: {
      vault,
      workspace: new FakeWorkspace(),
      secretStorage: new FakeSecretStorage(),
    },
    async loadData() {
      return data;
    },
    async saveData(next: unknown) {
      if (
        options.failMarkerSave === true &&
        typeof next === 'object' &&
        next !== null &&
        REBASE_MARKER_KEY in (next as Record<string, unknown>)
      ) {
        throw new Error('saveData refused the canonicalization marker write');
      }
      data = next as Record<string, unknown>;
    },
    registerInterval(id: number) {
      return id;
    },
    registerEvent() {},
  };
}

function installWindow(): void {
  (globalThis as { window?: unknown }).window = {
    setInterval: (fn: () => void, ms: number) =>
      globalThis.setInterval(fn, ms) as unknown as number,
    clearInterval: (id: number) => globalThis.clearInterval(id),
    setTimeout: (fn: () => void, ms: number) =>
      globalThis.setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

describe('owner connect resilience — a persisted pair is never discarded', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installWindow();
    mockRequestUrl.mockReset();
    mockRequestUrl.mockImplementation(async (opts: { url: string }) => {
      if (opts.url.includes('/owner/pair')) {
        return {
          status: 200,
          text: '',
          json: {
            vaultId: 'vault-1',
            deviceId: 'device-1',
            membershipId: 'member-1',
          },
        };
      }
      if (opts.url.includes('/auth/refresh')) {
        return {
          status: 200,
          text: '',
          json: {
            accessToken: 'access-token',
            accessExpiresAt: new Date(Date.now() + 900_000).toISOString(),
          },
        };
      }
      // Terminate the real-time wake long-poll deterministically so the loop
      // does not spin; any non-2xx that is not a heartbeat stops it.
      if (opts.url.includes('/wait')) {
        return { status: 401, text: '', json: {} };
      }
      return { status: 200, text: '', json: { cursor: 0, revisions: [] } };
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function connectOwner(plugin: unknown) {
    const { connectFromInput } = await import('./obsidian-adapters');
    const reports: string[] = [];
    const handle = await connectFromInput(
      plugin as never,
      'hm_pt_ownertoken',
      'https://havemind.example',
      { report: (m) => reports.push(m), onStatus: () => undefined },
    );
    return { handle, reports };
  }

  it('returns a started handle when the one-time rebase throws AFTER pairing', async () => {
    const plugin = makePlugin({ failMarkerSave: true });

    const { handle } = await connectOwner(plugin);

    expect(handle).not.toBeNull();
    // The session is live: tearing it down is the caller's job and must work.
    expect(() => handle?.stop()).not.toThrow();
  });

  it('returns a started handle when push-producer setup throws AFTER start', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const plugin = makePlugin({ failListenerRegistration: true });

    const { handle } = await connectOwner(plugin);

    expect(handle).not.toBeNull();
    // The real error must be logged (not swallowed blind) so it is diagnosable.
    expect(errorSpy).toHaveBeenCalled();
    // No orphaned loop: the caller can stop the handle it received.
    expect(() => handle?.stop()).not.toThrow();
  });

  it('still returns null on a genuine pre-pair failure (server 4xx) — real failures are not masked', async () => {
    mockRequestUrl.mockImplementation(async (opts: { url: string }) => {
      if (opts.url.includes('/owner/pair')) {
        return { status: 403, text: 'forbidden', json: {} };
      }
      return { status: 200, text: '', json: {} };
    });
    const plugin = makePlugin();

    const { handle } = await connectOwner(plugin);

    expect(handle).toBeNull();
  });
});
