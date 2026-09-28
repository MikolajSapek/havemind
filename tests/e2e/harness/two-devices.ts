/**
 * The two-device setup every e2e spec starts from: one real server with Alice
 * and Bob as harness clients, torn down after each case.
 *
 * Specs call `afterEach(stopHarnesses)`. Vitest isolates modules per test file,
 * so the list below is private to the spec that imports it.
 */
import { HarnessClient, type HarnessClientOptions } from './client.js';
import {
  cleanupHarnessDirectories,
  ServerHarness,
  type ServerHarnessOptions,
} from './server.js';

const harnesses: ServerHarness[] = [];

export interface TwoDevices {
  readonly server: ServerHarness;
  readonly alice: HarnessClient;
  readonly bob: HarnessClient;
}

export async function startTwoDevices(
  options: {
    readonly server?: ServerHarnessOptions;
    readonly alice?: HarnessClientOptions;
    readonly bob?: HarnessClientOptions;
  } = {},
): Promise<TwoDevices> {
  const server = await ServerHarness.create(options.server);
  harnesses.push(server);
  return {
    alice: new HarnessClient(server, server.alice, options.alice),
    bob: new HarnessClient(server, server.bob, options.bob),
    server,
  };
}

/** Closes every server started by `startTwoDevices` and removes its files. */
export async function stopHarnesses(): Promise<void> {
  await Promise.all(harnesses.splice(0).map(async (server) => server.close()));
  cleanupHarnessDirectories();
}
