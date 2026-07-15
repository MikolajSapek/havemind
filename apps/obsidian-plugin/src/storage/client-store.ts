export const CLIENT_STORE_NAMES = [
  'activity',
  'connection',
  'cursors',
  'deferred-applies',
  'file-mappings',
  'heads',
  'inbox',
  'outbox',
  'provenance',
] as const;

export const CLIENT_STORE_VERSION = 1;

const CLIENT_DATABASE_PREFIX = 'havemind-client-';
const CLIENT_INSTANCE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ClientStoreState =
  | 'blocked'
  | 'closed'
  | 'opening'
  | 'ready'
  | 'versionchange'
  | 'write-failed';

export type ClientStoreErrorCode =
  | 'blocked-upgrade'
  | 'closed'
  | 'invalid-client-instance-id'
  | 'quota-exceeded'
  | 'storage-unavailable'
  | 'transaction-failed'
  | 'version-changed';

export class ClientStoreError extends Error {
  override readonly name = 'ClientStoreError';

  constructor(
    readonly code: ClientStoreErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export interface ClientInstanceIdRepository {
  readClientInstanceId(): Promise<string | null>;
  writeClientInstanceId(value: string): Promise<void>;
}

export interface DurableOutboxEntry {
  createdAt: number;
  operationId: string;
  payload: unknown;
}

export interface IndexedDbClientStoreOptions {
  clientInstanceId: string;
  indexedDB?: IDBFactory;
}

export async function ensureClientInstanceId(
  repository: ClientInstanceIdRepository,
  generateId: () => string = generateClientInstanceId,
): Promise<string> {
  const existingId = await repository.readClientInstanceId();
  if (existingId !== null) {
    assertClientInstanceId(existingId);
    return existingId;
  }

  const generatedId = generateId();
  assertClientInstanceId(generatedId);
  await repository.writeClientInstanceId(generatedId);
  return generatedId;
}

export function isValidClientInstanceId(value: string): boolean {
  return (
    value.length >= 16 &&
    value.length <= 64 &&
    CLIENT_INSTANCE_ID_PATTERN.test(value)
  );
}

export class IndexedDbClientStore {
  readonly databaseName: string;

  private database: IDBDatabase | null = null;
  private indexedDB: IDBFactory;
  private openAttempt = 0;
  private storeState: ClientStoreState = 'closed';

  constructor(options: IndexedDbClientStoreOptions) {
    assertClientInstanceId(options.clientInstanceId);
    const indexedDB = options.indexedDB ?? globalThis.indexedDB;
    if (!indexedDB) {
      throw new ClientStoreError(
        'storage-unavailable',
        'IndexedDB is unavailable in this Obsidian runtime.',
      );
    }

    this.databaseName = `${CLIENT_DATABASE_PREFIX}${options.clientInstanceId}`;
    this.indexedDB = indexedDB;
  }

  get state(): ClientStoreState {
    return this.storeState;
  }

  async open(): Promise<void> {
    if (
      this.database &&
      (this.storeState === 'ready' || this.storeState === 'write-failed')
    ) {
      return;
    }
    if (this.storeState === 'opening') {
      throw new ClientStoreError(
        'transaction-failed',
        'The IndexedDB connection is already opening.',
      );
    }

    const attempt = ++this.openAttempt;
    this.storeState = 'opening';

    let request: IDBOpenDBRequest;
    try {
      request = this.indexedDB.open(
        this.databaseName,
        CLIENT_STORE_VERSION,
      );
    } catch (error) {
      this.storeState = 'closed';
      throw normalizeClientStoreError(error);
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const rejectOnce = (error: ClientStoreError): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      request.onupgradeneeded = () => {
        const database = request.result;
        for (const storeName of CLIENT_STORE_NAMES) {
          if (!database.objectStoreNames.contains(storeName)) {
            database.createObjectStore(storeName);
          }
        }
      };

      request.onblocked = () => {
        if (attempt !== this.openAttempt) return;
        this.storeState = 'blocked';
        rejectOnce(
          new ClientStoreError(
            'blocked-upgrade',
            'IndexedDB upgrade is blocked by another open Havemind client.',
          ),
        );
      };

      request.onerror = () => {
        if (attempt !== this.openAttempt) return;
        this.storeState = 'closed';
        rejectOnce(normalizeClientStoreError(request.error));
      };

      request.onsuccess = () => {
        const database = request.result;
        if (
          settled ||
          attempt !== this.openAttempt ||
          this.storeState !== 'opening'
        ) {
          database.close();
          rejectOnce(
            new ClientStoreError(
              'closed',
              'The IndexedDB connection was closed while opening.',
            ),
          );
          return;
        }

        settled = true;
        this.database = database;
        this.storeState = 'ready';
        database.onversionchange = () => {
          database.close();
          if (this.database === database) this.database = null;
          this.storeState = 'versionchange';
        };
        resolve();
      };
    });
  }

  close(): void {
    this.openAttempt += 1;
    this.database?.close();
    this.database = null;
    this.storeState = 'closed';
  }

  async setConnectionValue(key: string, value: unknown): Promise<void> {
    assertStorageKey(key);
    await this.runTransaction(
      'connection',
      'readwrite',
      (store) => store.put(value, key),
    );
  }

  async getConnectionValue(key: string): Promise<unknown> {
    assertStorageKey(key);
    return this.runTransaction('connection', 'readonly', (store) =>
      store.get(key),
    );
  }

  async enqueueOutbox(entry: DurableOutboxEntry): Promise<void> {
    assertOutboxEntry(entry);
    await this.runTransaction('outbox', 'readwrite', (store) =>
      store.put(entry, entry.operationId),
    );
  }

  async listOutbox(): Promise<DurableOutboxEntry[]> {
    const entries = await this.runTransaction<unknown[]>(
      'outbox',
      'readonly',
      (store) => store.getAll(),
    );
    return entries.map(parseOutboxEntry);
  }

  private requireDatabase(): IDBDatabase {
    if (
      this.database &&
      (this.storeState === 'ready' || this.storeState === 'write-failed')
    ) {
      return this.database;
    }

    if (this.storeState === 'versionchange') {
      throw new ClientStoreError(
        'version-changed',
        'The IndexedDB schema changed in another Havemind client.',
      );
    }

    throw new ClientStoreError(
      'closed',
      'The Havemind IndexedDB connection is not open.',
    );
  }

  private async runTransaction<T = IDBValidKey>(
    storeName: (typeof CLIENT_STORE_NAMES)[number],
    mode: IDBTransactionMode,
    createRequest: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const isWrite = mode === 'readwrite';
    let transaction: IDBTransaction;
    let request: IDBRequest<T>;

    try {
      transaction = this.requireDatabase().transaction(storeName, mode);
      request = createRequest(transaction.objectStore(storeName));
    } catch (error) {
      const normalized = normalizeClientStoreError(error);
      if (
        isWrite &&
        normalized.code !== 'closed' &&
        normalized.code !== 'version-changed'
      ) {
        this.storeState = 'write-failed';
      }
      throw normalized;
    }

    return new Promise<T>((resolve, reject) => {
      let requestResult: T | undefined;
      let requestSucceeded = false;
      let settled = false;

      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        if (isWrite) this.storeState = 'write-failed';
        reject(normalizeClientStoreError(error));
      };

      request.onsuccess = () => {
        requestResult = request.result;
        requestSucceeded = true;
      };
      request.onerror = () => {
        if (request.error) fail(request.error);
      };
      transaction.onerror = () => {
        fail(transaction.error ?? request.error);
      };
      transaction.onabort = () => {
        fail(transaction.error ?? request.error);
      };
      transaction.oncomplete = () => {
        if (settled) return;
        if (!requestSucceeded) {
          fail(
            new ClientStoreError(
              'transaction-failed',
              'IndexedDB completed without confirming the requested operation.',
            ),
          );
          return;
        }

        settled = true;
        if (isWrite) this.storeState = 'ready';
        resolve(requestResult as T);
      };
    });
  }
}

function assertClientInstanceId(value: string): void {
  if (!isValidClientInstanceId(value)) {
    throw new ClientStoreError(
      'invalid-client-instance-id',
      'client_instance_id must be 16-64 lowercase alphanumeric or hyphen characters.',
    );
  }
}

function assertStorageKey(value: string): void {
  if (value.length === 0 || value.length > 256) {
    throw new ClientStoreError(
      'transaction-failed',
      'IndexedDB keys must contain between 1 and 256 characters.',
    );
  }
}

function assertOutboxEntry(entry: DurableOutboxEntry): void {
  assertStorageKey(entry.operationId);
  if (!Number.isFinite(entry.createdAt) || entry.createdAt < 0) {
    throw new ClientStoreError(
      'transaction-failed',
      'Outbox createdAt must be a non-negative finite timestamp.',
    );
  }
}

function parseOutboxEntry(value: unknown): DurableOutboxEntry {
  if (!isRecord(value)) {
    throw new ClientStoreError(
      'transaction-failed',
      'IndexedDB contains a malformed outbox entry.',
    );
  }

  const entry: DurableOutboxEntry = {
    createdAt: value.createdAt as number,
    operationId: value.operationId as string,
    payload: value.payload,
  };
  if (
    typeof entry.operationId !== 'string' ||
    typeof entry.createdAt !== 'number'
  ) {
    throw new ClientStoreError(
      'transaction-failed',
      'IndexedDB contains a malformed outbox entry.',
    );
  }
  assertOutboxEntry(entry);
  return entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function generateClientInstanceId(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new ClientStoreError(
      'storage-unavailable',
      'Secure random UUID generation is unavailable in this Obsidian runtime.',
    );
  }
  return globalThis.crypto.randomUUID();
}

function normalizeClientStoreError(error: unknown): ClientStoreError {
  if (error instanceof ClientStoreError) return error;
  if (getErrorName(error) === 'QuotaExceededError') {
    return new ClientStoreError(
      'quota-exceeded',
      'IndexedDB quota was exceeded; the operation was not durably queued.',
      error,
    );
  }
  return new ClientStoreError(
    'transaction-failed',
    'The IndexedDB operation failed.',
    error,
  );
}

function getErrorName(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string'
  ) {
    return error.name;
  }
  return null;
}
