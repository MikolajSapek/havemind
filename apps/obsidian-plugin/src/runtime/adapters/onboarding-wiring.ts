/**
 * Assembly of the onboarding controller from the real Obsidian-backed ports, and
 * the single resolver that answers "which vault is this device connected to?"
 * across BOTH connection shapes, an owner paired via `/owner/pair` (a persisted
 * `ownerConnection` record) and an invitee whose pairing lives in its connected
 * onboarding state. Every owner-only action funnels through that resolver, so the
 * two shapes are reconciled in exactly one place.
 */

import type { Plugin } from 'obsidian';

import { OnboardingController } from '../../onboarding/controller';
import { ensureClientInstanceId } from '../../storage/client-store';
import { isConnectedOnboardingState } from '../connection';
import { RequestUrlOnboardingApi } from '../onboarding-api';
import { ObsidianOnboardingSecrets } from '../onboarding-secrets';
import { PluginDataOnboardingStore } from '../onboarding-store';

import { readOwnerConnection } from './owner-connection';
import {
  createClientInstanceRepo,
  createRawPersistPort,
} from './plugin-data-ports';
import { createRequestUrlFn } from './request-url';

/** Assembles the onboarding controller from the real Obsidian-backed ports. */
export async function buildOnboardingController(
  plugin: Plugin,
): Promise<{ controller: OnboardingController; store: PluginDataOnboardingStore }> {
  const clientInstanceId = await ensureClientInstanceId(
    createClientInstanceRepo(plugin),
  );
  const secrets = new ObsidianOnboardingSecrets({
    clientInstanceId,
    secretStorage: plugin.app.secretStorage,
  });
  const store = new PluginDataOnboardingStore({
    persist: createRawPersistPort(plugin),
  });
  const controller = new OnboardingController({
    clock: { now: () => Date.now() },
    remoteApi: new RequestUrlOnboardingApi({ requestUrl: createRequestUrlFn() }),
    secrets,
    store,
  });
  return { controller, store };
}

interface ConnectedVault {
  readonly apiBaseUrl: string;
  readonly vaultId: string;
  readonly serverOrigin: string;
}

/** Resolves the connected vault from an owner pairing or invitee onboarding. */
export async function resolveConnectedVault(
  plugin: Plugin,
): Promise<ConnectedVault | null> {
  const owner = await readOwnerConnection(plugin);
  if (owner !== null) {
    return {
      apiBaseUrl: owner.apiBaseUrl,
      vaultId: owner.vaultId,
      serverOrigin: owner.apiBaseUrl,
    };
  }
  const { controller: onboarding } = await buildOnboardingController(plugin);
  const state = await onboarding.resume();
  if (!isConnectedOnboardingState(state)) {
    return null;
  }
  const connected = state as unknown as ConnectedVault;
  return {
    apiBaseUrl: connected.apiBaseUrl,
    vaultId: connected.vaultId,
    serverOrigin: connected.serverOrigin,
  };
}
