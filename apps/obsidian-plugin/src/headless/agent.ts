/**
 * The headless Havemind client an AI agent runs as (plan 014).
 *
 * It joins a vault like a person's device does, through the owner's invitation
 * and six-digit approval, then syncs the vault into a folder on disk with the
 * plugin's own sync code: onboarding controller, refresh-token access,
 * transport, `SyncRunner`, outbox, vault apply and merge. Only the platform
 * ports differ (a folder instead of Obsidian's Vault, `fetch` instead of
 * `requestUrl`, files instead of `data.json`), the same seam the e2e harness
 * fills in `tests/e2e/onboarding-two-device.test.ts`.
 *
 * The agent changes the vault only through `writeNote` / `deleteNote`, which
 * hand the change to the push producer exactly as an Obsidian vault event
 * would. Every change carries the agent's own membership, so it is
 * attributed to the agent and can be undone like anyone's.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { hashPlaintext } from '@havemind/protocol';
import type { DecodedRevisionPayload } from '@havemind/sync-core';

import { OnboardingController, type OnboardingViewState } from '../onboarding/controller';
import { VaultChangeObserver } from '../obsidian/vault-adapter';
import { RefreshTokenAccessProvider } from '../runtime/access-token';
import { createVaultFilePort } from '../runtime/adapters/vault-file-port';
import { bootstrapIdentities } from '../runtime/bootstrap-identities';
import { CONFLICT_FOLDER } from '../runtime/conflict-resolution';
import { buildConnectionResolvers } from '../runtime/connection';
import { reconcileHeads } from '../runtime/head-reconciliation';
import { KeyedMutex } from '../runtime/keyed-mutex';
import { fetchMemberRoster } from '../runtime/member-roster';
import type { RosterMember } from '../runtime/roster';
import { RequestUrlOnboardingApi } from '../runtime/onboarding-api';
import { PluginDataOnboardingStore } from '../runtime/onboarding-store';
import { createRemoteApplyProducerSync } from '../runtime/remote-apply-coordinator';
import { RevisionHistory } from '../runtime/revision-history';
import { DurableSyncState } from '../runtime/sync-state';
import { RequestUrlTransport, type RequestUrlFn } from '../runtime/sync-transport';
import { VaultApplyAdapter } from '../runtime/vault-apply';
import { OutboxLocalChangeRepository } from '../sync/outbox-repository';
import { SyncRunner, type RemoteEvent, type SyncCycleResult } from '../sync/sync-runner';

import { createFetchRequestUrl } from './fetch-request-url';
import { openFsVault, type FsVault } from './fs-vault';
import { FileSecrets, jsonFile, syncStateFile } from './state-files';

export interface AgentPaths {
  /** Tokens and sync state; created 0700, files 0600. */
  readonly stateDir: string;
  /** The vault, mirrored as plain files. */
  readonly vaultDir: string;
  /** Defaults to `fetch`; tests inject the server directly. */
  readonly requestUrl?: RequestUrlFn;
}

export interface AgentIdentity {
  readonly apiBaseUrl: string;
  readonly vaultId: string;
  readonly vaultName: string;
  readonly memberId: string;
  readonly deviceId: string;
  /** The name the owner gave this agent in the invitation. */
  readonly name: string;
}

const APPROVAL_POLL_STEPS = 16;

function brandedToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

async function onboarding(paths: AgentPaths): Promise<OnboardingController> {
  await fs.mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  return new OnboardingController({
    clock: { now: () => Date.now() },
    remoteApi: new RequestUrlOnboardingApi({ requestUrl: paths.requestUrl ?? createFetchRequestUrl() }),
    secrets: new FileSecrets(paths.stateDir),
    store: new PluginDataOnboardingStore({ persist: jsonFile(paths.stateDir, 'onboarding.json') }),
  });
}

/**
 * Redeems the owner's invitation and returns the six digits the owner types
 * to approve this agent. Nothing is trusted from the invitation beyond what
 * the owner's server confirms.
 */
export async function startJoin(paths: AgentPaths, envelope: string, deviceLabel: string): Promise<string> {
  const controller = await onboarding(paths);
  controller.beginFromPastedEnvelope(envelope.trim());
  await controller.loadInvitationReview();
  const state = await controller.confirmInvitation(deviceLabel);
  if (state.phase !== 'pending-approval') {
    throw new Error(`The invitation could not be redeemed (${state.phase}).`);
  }
  return state.verificationPhrase;
}

/** Advances the stored onboarding until the owner approved (or refused) it. */
export async function finishJoin(paths: AgentPaths): Promise<AgentIdentity | null> {
  const controller = await onboarding(paths);
  for (let step = 0; step < APPROVAL_POLL_STEPS; step += 1) {
    const state: OnboardingViewState = await controller.resume();
    if (state.phase === 'connected') {
      return {
        apiBaseUrl: state.apiBaseUrl,
        vaultId: state.vaultId,
        vaultName: state.vaultName,
        memberId: state.memberId,
        deviceId: state.deviceId,
        name: state.intendedMemberDisplayName,
      };
    }
    if (state.phase === 'rejected') throw new Error('The owner refused this agent.');
    if (state.phase === 'pending-approval') return null;
  }
  return null;
}

/** A connected agent: sync the vault, read it, change it. */
export class HeadlessAgent {
  private constructor(
    readonly identity: AgentIdentity,
    private readonly fsVault: FsVault,
    private readonly runner: SyncRunner,
    private readonly observer: VaultChangeObserver,
    private readonly adoptExisting: () => Promise<void>,
    private readonly history: RevisionHistory,
    private readonly roster: () => Promise<readonly RosterMember[]>,
  ) {}

  static async open(paths: AgentPaths): Promise<HeadlessAgent> {
    // An agent added with one click (plan 015) has its identity on disk; one
    // that joined by invitation finishes its onboarding first.
    const claimed = (await jsonFile(paths.stateDir, 'identity.json').load()) as AgentIdentity | null;
    const identity = claimed ?? (await finishJoin(paths));
    if (identity === null) throw new Error('This agent is not approved yet.');
    const requestUrl = paths.requestUrl ?? createFetchRequestUrl();
    const secrets = new FileSecrets(paths.stateDir);
    const access = new RefreshTokenAccessProvider({
      requestUrl,
      apiBaseUrl: identity.apiBaseUrl,
      getRefreshToken: () => secrets.getRefreshToken(),
      saveRefreshToken: (value) => secrets.saveRefreshToken(value),
      generateRotationId: () => brandedToken('hm_ri_'),
      generateSuccessorToken: () => brandedToken('hm_rt_'),
    });
    const getAuthToken = () => access.getAccessToken();
    const state = new DurableSyncState({ persist: syncStateFile(paths.stateDir) });
    const pushIdentity = { vaultId: identity.vaultId, memberId: identity.memberId, deviceId: identity.deviceId };
    const transport = new RequestUrlTransport({
      requestUrl,
      apiBaseUrl: identity.apiBaseUrl,
      vaultId: identity.vaultId,
      getAuthToken,
      resolveEnvelope: (revisionId) => state.peekEnvelope(revisionId),
      identity: pushIdentity,
    });
    const resolvers = buildConnectionResolvers({
      apiBaseUrl: identity.apiBaseUrl,
      vaultId: identity.vaultId,
      getAccessToken: getAuthToken,
      requestUrl,
    });
    const history = new RevisionHistory({ transport, state, resolveRevision: resolvers.resolveRevision });
    const fsVault = await openFsVault(paths.vaultDir);
    const files = createVaultFilePort({ vault: fsVault.vault as never, state });
    const lock = new KeyedMutex();
    const producer = new OutboxLocalChangeRepository({
      recovery: state,
      identity: pushIdentity,
      store: { load: () => state.loadProducer(), save: (next) => state.saveProducer(next) },
      hasAuthoredRevision: (revisionId) => state.hasAuthoredRevision(revisionId),
      generateRevisionId: () => randomUUID(),
    });
    const vault = new VaultApplyAdapter({
      lock,
      history,
      files,
      conflictFolder: CONFLICT_FOLDER,
      resolveRevision: resolvers.resolveRevision,
      hashContent: async (content) => hashPlaintext(content),
      producerSync: createRemoteApplyProducerSync(() => producer),
    });
    const runner = new SyncRunner({
      beforeCycle: () => producer.recover(),
      beforePull: () => history.refresh(),
      afterPull: () => reconcileHeads({ history, state, producer, files, lock }),
      transport,
      state,
      vault,
      scheduler: () => undefined,
    });
    const observer = new VaultChangeObserver({
      clock: () => Date.now(),
      generateFileId: () => randomUUID(),
      generateOperationId: () => randomUUID(),
      repository: producer,
      vault: fsVault.snapshot,
    });
    // An agent never scans its folder for changes: whatever lands there by
    // other means (a person's editor, Claude Code's own file tools in MCP mode)
    // must not leave as the agent. Its only changes are `writeNote` calls,
    // which the scoped write path guards. Identities still come back from the
    // history so a restart maps the files it already has.
    const adoptExisting = async (): Promise<void> => {
      await bootstrapIdentities({ history, state, producer, vault: fsVault.snapshot });
    };
    const roster = (): Promise<RosterMember[]> =>
      fetchMemberRoster({
        apiBaseUrl: identity.apiBaseUrl,
        requestUrl,
        getRefreshToken: () => secrets.getRefreshToken(),
        vaultId: identity.vaultId,
        selfMembershipId: identity.memberId,
      });
    return new HeadlessAgent(identity, fsVault, runner, observer, adoptExisting, history, roster);
  }

  /** One push and pull with the server; the first call also maps the files already on disk. */
  async sync(): Promise<SyncCycleResult> {
    if (!this.adopted) {
      await this.adoptExisting();
      this.adopted = true;
    }
    return this.runner.trigger();
  }

  private adopted = false;

  /** The newest server sequence this agent has; a fresh agent starts its runs here. */
  async latestSequence(): Promise<number> {
    return Math.max(0, ...(await this.history.allHeads()).map((head) => head.serverSequence));
  }

  /**
   * Notes people (not this or any other agent) changed after server sequence
   * `after`, and the newest sequence seen. An agent acts on these only, so it
   * never triggers itself or another agent.
   */
  async peopleChangesSince(after: number): Promise<{ latest: number; paths: string[]; authors: Record<string, string> }> {
    const members = await this.roster();
    const agents = new Set([this.identity.memberId, ...members.filter((m) => m.kind === 'agent').map((m) => m.membershipId)]);
    const names = new Map(members.map((m) => [m.membershipId, m.displayName]));
    let latest = after;
    const paths: string[] = [];
    const authors: Record<string, string> = {};
    for (const head of await this.history.allHeads()) {
      latest = Math.max(latest, head.serverSequence);
      const author = head.revision.authorMembershipId;
      if (head.serverSequence <= after || author === undefined || agents.has(author)) continue;
      const payload = await this.history.payload(head);
      if (payload.operation === 'delete') continue;
      if (await this.revertsOwnWork(head, payload)) continue;
      paths.push(payload.path);
      const name = names.get(author);
      if (name !== undefined) authors[payload.path] = name;
    }
    return { latest, paths: paths.sort(), authors };
  }

  /**
   * Whether `head` puts a note back to what it was before one of this agent's
   * own revisions (the owner clicked Undo). That is a verdict on the agent's
   * work, not news: acting on it would redo the work the owner just undid.
   * Compared by the note's text: a revision's `contentHash` covers its whole
   * payload, so a revert never has the same one.
   */
  private async revertsOwnWork(head: RemoteEvent, payload: DecodedRevisionPayload): Promise<boolean> {
    if (payload.content === null || payload.kind === 'binary') return false;
    const graph = await this.history.graph(head.revision.fileId);
    for (const event of graph.values()) {
      if (event.revision.authorMembershipId !== this.identity.memberId) continue;
      for (const parentId of event.revision.parentRevisionIds ?? []) {
        const parent = graph.get(parentId);
        if (parent === undefined) continue;
        const before = await this.history.payload(parent);
        if (before.operation !== 'delete' && before.content === payload.content) return true;
      }
    }
    return false;
  }

  async listNotes(): Promise<readonly string[]> {
    return (await this.fsVault.snapshot.listSyncablePaths()).filter((path) => path.endsWith('.md')).sort();
  }

  async readNote(path: string): Promise<string | null> {
    return (await this.fsVault.snapshot.exists(path)) ? this.fsVault.snapshot.readText(path) : null;
  }

  /**
   * Creates or replaces a note and queues it for the next `sync()`. The client
   * primitive: an agent's own writes go through `writeAsAgent` in `runner.ts`,
   * which checks the task note's scope first.
   */
  async writeNote(path: string, content: string): Promise<void> {
    const vault = this.fsVault.vault as {
      getAbstractFileByPath(path: string): { path: string } | null;
      createFolder(path: string): Promise<void>;
      create(path: string, content: string): Promise<unknown>;
      modify(file: { path: string }, content: string): Promise<void>;
    };
    const segments = path.split('/').slice(0, -1);
    for (let i = 1; i <= segments.length; i += 1) {
      const folder = segments.slice(0, i).join('/');
      if (vault.getAbstractFileByPath(folder) === null) await vault.createFolder(folder);
    }
    const existing = vault.getAbstractFileByPath(path);
    if (existing === null) {
      await vault.create(path, content);
      await this.observer.observeCreate(path);
    } else {
      await vault.modify(existing, content);
      await this.observer.observeModify(path);
    }
  }
}
