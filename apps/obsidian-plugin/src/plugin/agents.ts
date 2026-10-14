/** One-click agents (plan 015): the owner's "Add agent" form and what it does. */

import type HavemindPlugin from '../main';
import { addAgent, modelKeyConfigured, setModelKey } from '../runtime/agent-api';
import { agentApiForOwner } from '../runtime/obsidian-adapters';
import type { AddAgentModel, AgentLogin } from '../ui/screens/add-agent';

import { writeTaskNote } from './invitations';

export class Agents {
  private formOpen = false;
  private keyNeeded: boolean | null = null;
  private unsupported = false;
  /** Shown in People after an agent was added. */
  public notice: string | undefined;

  public constructor(private readonly plugin: HavemindPlugin) {}

  public model(): AddAgentModel | null {
    if (!this.formOpen) return null;
    return { keyNeeded: this.keyNeeded, ...(this.unsupported ? { unsupported: true } : {}) };
  }

  public open(): void {
    this.formOpen = true;
    this.keyNeeded = null;
    this.unsupported = false;
    this.notice = undefined;
    this.plugin.views.refreshOnboardingNow();
    void this.checkKey();
  }

  public close(): void {
    this.formOpen = false;
    this.plugin.views.refreshOnboardingNow();
  }

  private async checkKey(): Promise<void> {
    const api = await agentApiForOwner(this.plugin);
    const configured = api === null ? null : await modelKeyConfigured(api).catch(() => null);
    this.unsupported = configured === null;
    this.keyNeeded = configured === null ? null : !configured;
    this.plugin.views.refreshOnboardingNow();
  }

  public async add(presetId: string, name: string, login: AgentLogin, report: (message: string) => void): Promise<void> {
    const api = await agentApiForOwner(this.plugin);
    if (api === null) {
      report('Connect as the vault owner first.');
      return;
    }
    try {
      if (login?.kind === 'local') {
        report('Claude Code on this computer is not available yet in this build.');
        return;
      }
      if (login !== null) {
        const saved = await setModelKey(api, login);
        if (saved !== 'saved') {
          // Never the secret itself in a message.
          report(
            saved === 'invalid'
              ? login.kind === 'subscription'
                ? 'That does not look like a token from claude setup-token (sk-ant-oat01-…).'
                : 'That does not look like an Anthropic API key (sk-ant-api03-…).'
              : 'Could not save it on the server.',
          );
          return;
        }
      }
      const added = await addAgent(api, name);
      if (added === 'name-taken') {
        report(`A member or agent is already called ${name}. Pick another name.`);
        return;
      }
      if (added !== 'added') {
        report(added === 'unsupported' ? 'This server cannot add agents with one click yet; update it.' : 'Could not add the agent.');
        return;
      }
      await writeTaskNote(this.plugin, name, presetId);
      this.notice = `${name} is joining. It appears in yellow within a minute; its task is in Havemind/Agents/${name}.md.`;
      this.formOpen = false;
      this.plugin.views.refreshOnboardingNow();
    } catch {
      report('Could not reach the server. Try again in a moment.');
    }
  }
}
