/**
 * A single serialized read-modify-write queue over ONE plugin's `data.json`.
 *
 * MAJOR (concurrent-save clobber): every durable non-secret store, the sync
 * state, the push producer, the client-instance id, the owner connection, the
 * roster and the onboarding store, persists under its own top-level key by
 * reading the whole blob, merging its key and writing the whole blob back
 * (`saveData({ ...loadData(), [ownKey]: value })`). With no shared lock, two of
 * these racing on different keys clobber each other on disk: both read the same
 * snapshot and the later write drops the earlier one's key. Routing every
 * load-modify-save through this per-plugin mutex means each critical section
 * re-reads the LATEST on-disk snapshot immediately before it writes, so a save
 * to one key can never overwrite a concurrent save to another.
 */

export interface PluginDataAccess {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class PluginDataMutex {
  private readonly access: PluginDataAccess;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(access: PluginDataAccess) {
    this.access = access;
  }

  /** The current on-disk blob (an empty record when absent/malformed). */
  load(): Promise<Record<string, unknown>> {
    return this.enqueue(async () => {
      const data = await this.access.loadData();
      return isRecord(data) ? data : {};
    });
  }

  /**
   * Atomically read-modify-write the whole blob: `mutator` receives the LATEST
   * on-disk snapshot (read inside the critical section) and returns the blob to
   * persist. Runs strictly after every previously-enqueued operation.
   */
  update(
    mutator: (current: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    return this.enqueue(async () => {
      const data = await this.access.loadData();
      const base = isRecord(data) ? data : {};
      await this.access.saveData(mutator(base));
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    // Chain the task after whatever is queued, regardless of that link's
    // outcome, so one caller's rejection never skips or wedges the next.
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export interface SerializedDataPort {
  load(): Promise<Record<string, unknown>>;
  save(data: Record<string, unknown>): Promise<void>;
}

/**
 * A `{ load, save }` port over a shared {@link PluginDataMutex}, for the stores
 * that split their read-modify-write across two calls (roster, onboarding).
 * `save` re-reads the latest on-disk snapshot under the lock and re-applies
 * ONLY the top-level keys this port actually changed since its own `load`, so
 * a concurrent save to a different key is preserved rather than clobbered.
 */
export function createSerializedDataPort(
  mutex: PluginDataMutex,
): SerializedDataPort {
  let lastLoaded: Record<string, unknown> = {};
  return {
    async load() {
      lastLoaded = await mutex.load();
      return lastLoaded;
    },
    async save(data) {
      const loadedAtSave = lastLoaded;
      await mutex.update((disk) => {
        const next: Record<string, unknown> = { ...disk };
        for (const key of Object.keys(data)) {
          // Only keys this port changed relative to what it loaded are written;
          // untouched keys keep their spread-through reference and are skipped,
          // so a concurrent writer's change to a different key stands.
          if (data[key] !== loadedAtSave[key]) {
            next[key] = data[key];
          }
        }
        return next;
      });
    },
  };
}

/** One shared mutex per plugin instance, so every store funnels onto one queue. */
const mutexes = new WeakMap<PluginDataAccess, PluginDataMutex>();

export function getPluginDataMutex(access: PluginDataAccess): PluginDataMutex {
  const existing = mutexes.get(access);
  if (existing !== undefined) return existing;
  const created = new PluginDataMutex(access);
  mutexes.set(access, created);
  return created;
}
