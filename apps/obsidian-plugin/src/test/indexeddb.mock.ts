type EventHandler = ((event: Event) => unknown) | null;

class FakeRequest {
  error: DOMException | null = null;
  onerror: EventHandler = null;
  onsuccess: EventHandler = null;
  result: unknown = undefined;
}

class FakeOpenRequest extends FakeRequest {
  onblocked: EventHandler = null;
  onupgradeneeded: EventHandler = null;
  transaction: IDBTransaction | null = null;
}

type StoredDatabase = {
  stores: Map<string, Map<string, unknown>>;
  version: number;
};

class FakeDomStringList {
  constructor(private readonly values: () => readonly string[]) {}

  get length(): number {
    return this.values().length;
  }

  contains(value: string): boolean {
    return this.values().includes(value);
  }

  item(index: number): string | null {
    return this.values()[index] ?? null;
  }
}

class FakeObjectStore {
  constructor(
    private readonly records: Map<string, unknown>,
    private readonly transaction: FakeTransaction,
  ) {}

  get(key: IDBValidKey | IDBKeyRange): IDBRequest {
    const request = new FakeRequest();
    this.transaction.run(request, () => {
      request.result = clone(this.records.get(toKey(key)));
    });
    return request as unknown as IDBRequest;
  }

  getAll(): IDBRequest {
    const request = new FakeRequest();
    this.transaction.run(request, () => {
      request.result = [...this.records.values()].map((value) => clone(value));
    });
    return request as unknown as IDBRequest;
  }

  put(value: unknown, key?: IDBValidKey): IDBRequest {
    const request = new FakeRequest();
    this.transaction.run(
      request,
      () => {
        if (key === undefined) {
          throw new DOMException('A key is required by this fake store.', 'DataError');
        }

        this.records.set(toKey(key), clone(value));
        request.result = key;
      },
      true,
    );
    return request as unknown as IDBRequest;
  }
}

class FakeTransaction {
  error: DOMException | null = null;
  onabort: EventHandler = null;
  oncomplete: EventHandler = null;
  onerror: EventHandler = null;

  private operationStarted = false;

  constructor(
    private readonly records: Map<string, unknown>,
    private readonly takeWriteFailure: () => DOMException | null,
    private readonly takeCommitFailure: () => DOMException | null,
  ) {}

  objectStore(): IDBObjectStore {
    return new FakeObjectStore(
      this.records,
      this,
    ) as unknown as IDBObjectStore;
  }

  run(request: FakeRequest, operation: () => void, isWrite = false): void {
    if (this.operationStarted) {
      throw new Error('The IndexedDB test fake supports one request per transaction.');
    }

    this.operationStarted = true;
    queueMicrotask(() => {
      const injectedFailure = isWrite ? this.takeWriteFailure() : null;
      if (injectedFailure) {
        request.error = injectedFailure;
        this.error = injectedFailure;
        request.onerror?.(new Event('error'));
        this.onerror?.(new Event('error'));
        this.onabort?.(new Event('abort'));
        return;
      }

      try {
        const snapshot = isWrite ? new Map(this.records) : null;
        operation();
        request.onsuccess?.(new Event('success'));
        const commitFailure = isWrite ? this.takeCommitFailure() : null;
        if (commitFailure) {
          this.records.clear();
          for (const [key, value] of snapshot ?? []) {
            this.records.set(key, value);
          }
          this.error = commitFailure;
          this.onerror?.(new Event('error'));
          this.onabort?.(new Event('abort'));
          return;
        }
        this.oncomplete?.(new Event('complete'));
      } catch (error) {
        const storageError =
          error instanceof DOMException
            ? error
            : new DOMException('Fake transaction failed.', 'UnknownError');
        request.error = storageError;
        this.error = storageError;
        request.onerror?.(new Event('error'));
        this.onerror?.(new Event('error'));
        this.onabort?.(new Event('abort'));
      }
    });
  }
}

class FakeDatabase {
  onversionchange: EventHandler = null;

  readonly objectStoreNames: DOMStringList;

  private closed = false;

  constructor(
    readonly name: string,
    private readonly record: StoredDatabase,
    private readonly factory: FakeIndexedDbFactory,
  ) {
    this.objectStoreNames = new FakeDomStringList(
      () => [...this.record.stores.keys()],
    ) as unknown as DOMStringList;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.factory.forgetConnection(this);
  }

  createObjectStore(name: string): IDBObjectStore {
    if (this.record.stores.has(name)) {
      throw new DOMException('Object store already exists.', 'ConstraintError');
    }

    const records = new Map<string, unknown>();
    this.record.stores.set(name, records);
    return new FakeObjectStore(
      records,
      new FakeTransaction(
        records,
        () => null,
        () => null,
      ),
    ) as unknown as IDBObjectStore;
  }

  dispatchVersionChange(): void {
    this.onversionchange?.(new Event('versionchange'));
  }

  transaction(storeName: string): IDBTransaction {
    if (this.closed) {
      throw new DOMException('Database connection is closed.', 'InvalidStateError');
    }

    const records = this.record.stores.get(storeName);
    if (!records) {
      throw new DOMException('Object store does not exist.', 'NotFoundError');
    }

    return new FakeTransaction(
      records,
      () => this.factory.takeWriteFailure(),
      () => this.factory.takeCommitFailure(),
    ) as unknown as IDBTransaction;
  }
}

export class FakeIndexedDbFactory {
  private readonly connections = new Set<FakeDatabase>();
  private readonly databases = new Map<string, StoredDatabase>();
  private blockedOpenContinuation: (() => void) | null = null;
  private nextOpenIsBlocked = false;
  private nextCommitFailure: DOMException | null = null;
  private nextWriteFailure: DOMException | null = null;

  asFactory(): IDBFactory {
    return this as unknown as IDBFactory;
  }

  blockNextOpen(): void {
    this.nextOpenIsBlocked = true;
  }

  failNextWrite(error: DOMException): void {
    this.nextWriteFailure = error;
  }

  failNextCommit(error: DOMException): void {
    this.nextCommitFailure = error;
  }

  forgetConnection(database: FakeDatabase): void {
    this.connections.delete(database);
  }

  getOpenConnectionCount(): number {
    return this.connections.size;
  }

  getStoreNames(databaseName: string): readonly string[] {
    return [...(this.databases.get(databaseName)?.stores.keys() ?? [])];
  }

  open(name: string, version?: number): IDBOpenDBRequest {
    const request = new FakeOpenRequest();
    const completeOpen = (): void => {
      const requestedVersion = version ?? 1;
      let record = this.databases.get(name);
      const oldVersion = record?.version ?? 0;
      if (record && requestedVersion < record.version) {
        request.error = new DOMException(
          'The requested version is older than the stored version.',
          'VersionError',
        );
        request.onerror?.(new Event('error'));
        return;
      }

      if (!record) {
        record = { stores: new Map(), version: 0 };
        this.databases.set(name, record);
      }

      const database = new FakeDatabase(name, record, this);
      request.result = database;
      this.connections.add(database);

      if (requestedVersion > oldVersion) {
        request.transaction = {} as IDBTransaction;
        request.onupgradeneeded?.(new Event('upgradeneeded'));
        record.version = requestedVersion;
      }

      request.onsuccess?.(new Event('success'));
    };
    queueMicrotask(() => {
      if (this.nextOpenIsBlocked) {
        this.nextOpenIsBlocked = false;
        this.blockedOpenContinuation = completeOpen;
        request.onblocked?.(new Event('blocked'));
        return;
      }

      completeOpen();
    });
    return request as unknown as IDBOpenDBRequest;
  }

  releaseBlockedOpen(): void {
    const continuation = this.blockedOpenContinuation;
    this.blockedOpenContinuation = null;
    continuation?.();
  }

  takeWriteFailure(): DOMException | null {
    const failure = this.nextWriteFailure;
    this.nextWriteFailure = null;
    return failure;
  }

  takeCommitFailure(): DOMException | null {
    const failure = this.nextCommitFailure;
    this.nextCommitFailure = null;
    return failure;
  }

  triggerVersionChange(databaseName: string): void {
    for (const connection of [...this.connections]) {
      if (connection.name === databaseName) connection.dispatchVersionChange();
    }
  }
}

function clone(value: unknown): unknown {
  return value === undefined ? undefined : structuredClone(value);
}

function toKey(key: IDBValidKey | IDBKeyRange): string {
  if (typeof key !== 'string') {
    throw new DOMException('This fake supports string keys only.', 'DataError');
  }
  return key;
}
