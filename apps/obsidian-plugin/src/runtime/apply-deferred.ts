/** A local save or editor change won the race. Retry without advancing the cursor. */
export class ApplyDeferredError extends Error {
  override readonly name = 'ApplyDeferredError';
  constructor() { super('Local content changed during remote apply.'); }
}
