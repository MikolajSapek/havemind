export type BlobStoreFaultPoint =
  | 'after-temp-write'
  | 'after-file-fsync'
  | 'after-rename'
  | 'after-directory-fsync';

export interface BlobStoreFaultInjector {
  hit(point: BlobStoreFaultPoint): Promise<void> | void;
}

export class InjectedFaultError extends Error {
  public readonly point: BlobStoreFaultPoint;

  public constructor(point: BlobStoreFaultPoint) {
    super(`Injected blob-store fault at ${point}.`);
    this.name = 'InjectedFaultError';
    this.point = point;
  }
}

export function failOnceAt(
  expectedPoint: BlobStoreFaultPoint,
): BlobStoreFaultInjector {
  let armed = true;

  return {
    hit(point): void {
      if (armed && point === expectedPoint) {
        armed = false;
        throw new InjectedFaultError(point);
      }
    },
  };
}
