/**
 * The agents service picks up agents the owner added with one click (plan 015).
 *
 * It asks the server for the next waiting agent with its service token, after
 * writing the refresh token and redemption id it will send to `.claiming.json`
 * (0600): if the answer is lost, the next try sends the same values and the
 * server returns the same agent rather than a second one. The claimed agent's
 * identity is stored beside its secrets; it never goes through the invitation
 * flow.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { RequestUrlFn } from '../runtime/sync-transport';

import type { AgentIdentity } from './agent';
import { FileSecrets, jsonFile } from './state-files';

export const AGENT_SERVICE_HEADER = 'x-havemind-agent-service-token';
const CLAIMING_FILE = '.claiming.json';

interface Claiming {
  readonly redemptionId: string;
  readonly refreshToken: string;
}

export function folderFor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'agent';
}

export interface ClaimOptions {
  readonly agentsDir: string;
  readonly apiBaseUrl: string;
  readonly serviceToken: string;
  readonly requestUrl: RequestUrlFn;
}

/** Claims one waiting agent; returns its folder, or null when none waits. */
export async function claimNextAgent(options: ClaimOptions): Promise<string | null> {
  await fs.mkdir(options.agentsDir, { recursive: true, mode: 0o700 });
  const claimingFile = jsonFile(options.agentsDir, CLAIMING_FILE);
  const saved = (await claimingFile.load()) as Claiming | null;
  const claiming: Claiming = saved ?? {
    redemptionId: randomUUID(),
    refreshToken: `hm_rt_${randomBytes(32).toString('base64url')}`,
  };
  if (saved === null) await claimingFile.save(claiming);

  const response = await options.requestUrl({
    url: `${options.apiBaseUrl}/agent-service/claim`,
    method: 'POST',
    headers: { 'content-type': 'application/json', [AGENT_SERVICE_HEADER]: options.serviceToken },
    body: JSON.stringify({ initialRefreshToken: claiming.refreshToken, redemptionId: claiming.redemptionId }),
  });
  if (response.status === 204) {
    // Nothing was claimed with these values, so they are safe to forget.
    await fs.rm(join(options.agentsDir, CLAIMING_FILE), { force: true });
    return null;
  }
  if (response.status !== 200) throw new Error(`The server refused the claim (${response.status}).`);
  const body = response.json as {
    apiBaseUrl: string; vaultId: string; vaultName: string; membershipId: string; deviceId: string; name: string;
  };
  const folder = folderFor(body.name);
  const stateDir = join(options.agentsDir, folder, 'state');
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await new FileSecrets(stateDir).saveRefreshToken(claiming.refreshToken);
  const identity: AgentIdentity = {
    apiBaseUrl: body.apiBaseUrl,
    vaultId: body.vaultId,
    vaultName: body.vaultName,
    memberId: body.membershipId,
    deviceId: body.deviceId,
    name: body.name,
  };
  await jsonFile(stateDir, 'identity.json').save(identity);
  await fs.rm(join(options.agentsDir, CLAIMING_FILE), { force: true });
  return folder;
}
