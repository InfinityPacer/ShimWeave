import {
  type SampleEvidenceRepository,
  type StoredSampleEvidence,
  selectPreferredSampleEvidence,
} from '@shimweave/core';

const DATABASE_VERSION = 1;
const STORE_NAME = 'samples';
const LAST_ACCESSED_INDEX = 'lastAccessedAt';

/** IndexedDB 事务负责跨标签合并能力结论，局部失败不能覆盖已经验证的成功路径。 */
export class IndexedDbSampleEvidenceRepository implements SampleEvidenceRepository {
  private databasePromise: Promise<IDBDatabase> | undefined;

  constructor(
    private readonly databaseName = 'shimweave-capabilities',
    private readonly factory: IDBFactory = indexedDB,
  ) {}

  async read(key: string): Promise<StoredSampleEvidence | undefined> {
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const value = await requestResult<StoredSampleEvidence | undefined>(
      transaction.objectStore(STORE_NAME).get(key),
    );
    await transactionDone(transaction);
    return value;
  }

  async writeIfNewer(record: StoredSampleEvidence): Promise<StoredSampleEvidence> {
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const existing = await requestResult<StoredSampleEvidence | undefined>(store.get(record.key));
    const selectedEvidence = selectPreferredSampleEvidence(existing?.evidence, record.evidence);
    const selected = existing?.evidence === selectedEvidence ? existing : record;
    if (selected === record) await requestResult(store.put(record));
    await transactionDone(transaction);
    return selected;
  }

  async touch(key: string, lastAccessedAt: number): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const existing = await requestResult<StoredSampleEvidence | undefined>(store.get(key));
    if (existing && existing.lastAccessedAt < lastAccessedAt) {
      await requestResult(store.put({ ...existing, lastAccessedAt }));
    }
    await transactionDone(transaction);
  }

  async delete(key: string): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    await requestResult(transaction.objectStore(STORE_NAME).delete(key));
    await transactionDone(transaction);
  }

  async deleteOlderThan(cutoff: number): Promise<number> {
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const index = transaction.objectStore(STORE_NAME).index(LAST_ACCESSED_INDEX);
    const request = index.openCursor(IDBKeyRange.upperBound(cutoff, true));
    let deleted = 0;
    await new Promise<void>((resolve, reject) => {
      request.addEventListener('success', () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        cursor.delete();
        deleted += 1;
        cursor.continue();
      });
      request.addEventListener('error', () => reject(request.error));
    });
    await transactionDone(transaction);
    return deleted;
  }

  close(): void {
    void this.databasePromise?.then((database) => database.close());
    this.databasePromise = undefined;
  }

  private database(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(this.databaseName, DATABASE_VERSION);
      request.addEventListener('upgradeneeded', () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(STORE_NAME)
          ? request.transaction?.objectStore(STORE_NAME)
          : database.createObjectStore(STORE_NAME, { keyPath: 'key' });
        if (store && !store.indexNames.contains(LAST_ACCESSED_INDEX)) {
          store.createIndex(LAST_ACCESSED_INDEX, LAST_ACCESSED_INDEX);
        }
      });
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error));
      request.addEventListener('blocked', () =>
        reject(new Error('ShimWeave capability database upgrade is blocked')),
      );
    });
    return this.databasePromise;
  }
}

const requestResult = <Result>(request: IDBRequest<Result>): Promise<Result> =>
  new Promise<Result>((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error));
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve());
    transaction.addEventListener('abort', () => reject(transaction.error));
    transaction.addEventListener('error', () => reject(transaction.error));
  });
