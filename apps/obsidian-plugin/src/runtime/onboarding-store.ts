/**
 * `OnboardingStorePort` over a plugin-data persistence boundary. The durable
 * onboarding state and the set of fileIds seen during bootstrap are non-secret
 * bookkeeping, so they live in `data.json` under a dedicated key. Committing a
 * bootstrap page persists the advanced state and the page's fileIds atomically
 * (a single save), so a restart resumes bootstrap without losing progress.
 *
 * Bootstrap items are untrusted server output: any malformed item is skipped
 * rather than throwing, so one bad row cannot wedge the connect flow.
 */

import type {
  DurableOnboardingState,
  OnboardingStorePort,
} from '../onboarding/controller';

const ONBOARDING_KEY = 'onboarding';

export interface OnboardingPersistPort {
  load(): Promise<unknown>;
  save(data: unknown): Promise<void>;
}

interface PersistedOnboarding {
  readonly state: DurableOnboardingState | null;
  readonly fileIds: readonly string[];
}

export interface PluginDataOnboardingStoreOptions {
  readonly persist: OnboardingPersistPort;
}

export class PluginDataOnboardingStore implements OnboardingStorePort {
  private readonly persist: OnboardingPersistPort;
  private cache: PersistedOnboarding | null = null;

  constructor(options: PluginDataOnboardingStoreOptions) {
    this.persist = options.persist;
  }

  async loadState(): Promise<unknown> {
    return (await this.ensureLoaded()).state;
  }

  async saveState(state: DurableOnboardingState): Promise<void> {
    const current = await this.ensureLoaded();
    await this.mutate({ ...current, state });
  }

  async commitBootstrapPage(
    items: readonly unknown[],
    state: DurableOnboardingState,
  ): Promise<void> {
    const current = await this.ensureLoaded();
    const pageFileIds = items
      .map(extractFileId)
      .filter((id): id is string => id !== null);
    const fileIds = [...new Set([...current.fileIds, ...pageFileIds])];
    await this.mutate({ fileIds, state });
  }

  /** FileIds observed during bootstrap, for the path-mapping resolver. */
  knownFileIds(): readonly string[] {
    return this.cache?.fileIds ?? [];
  }

  private async ensureLoaded(): Promise<PersistedOnboarding> {
    if (this.cache !== null) return this.cache;
    const raw = await this.persist.load();
    this.cache = parsePersisted(raw);
    return this.cache;
  }

  private async mutate(next: PersistedOnboarding): Promise<void> {
    this.cache = next;
    const data = await this.persist.load();
    const base = isRecord(data) ? data : {};
    await this.persist.save({ ...base, [ONBOARDING_KEY]: next });
  }
}

function parsePersisted(raw: unknown): PersistedOnboarding {
  const container = isRecord(raw) ? raw[ONBOARDING_KEY] : null;
  if (!isRecord(container)) {
    return { state: null, fileIds: [] };
  }
  const fileIds = Array.isArray(container.fileIds)
    ? container.fileIds.filter((id): id is string => typeof id === 'string')
    : [];
  const state = isRecord(container.state)
    ? (container.state as unknown as DurableOnboardingState)
    : null;
  return { state, fileIds };
}

function extractFileId(item: unknown): string | null {
  if (isRecord(item) && typeof item.fileId === 'string') {
    return item.fileId;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
