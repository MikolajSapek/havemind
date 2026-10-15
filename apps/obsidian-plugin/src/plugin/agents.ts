/** One-click agents (plan 015): the owner's "Add agent" form and what it does. */

import type HavemindPlugin from '../main';
import { addAgent, modelKeyConfigured, setModelKey } from '../runtime/agent-api';
import { agentApiForOwner } from '../runtime/obsidian-adapters';
import type { AddAgentModel, AgentLogin } from '../ui/screens/add-agent';

import { agentNameProblem } from './agent-name';
import { writeTaskNote } from './invitations';

const INVALID: Readonly<Record<string, string>> = {
  'claude-code': 'That does not look like a token from claude setup-token (sk-ant-oat01-…).',
  codex: 'That does not look like a Codex auth.json.',
  anthropic: 'That does not look like an Anthropic API key (sk-ant-api03-…).',
  'openai-compatible': 'Check the address (https, or http to this machine) and the model name.',
};

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

  /** The agents service claims it within a minute; show it as soon as it is there. */
  private async waitForAgent(name: string): Promise<void> {
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 20_000));
      if (this.plugin.unloaded) return;
      await this.plugin.people.refreshRoster();
      if (this.plugin.people.rosterMembers.some((member) => member.kind === 'agent' && member.displayName === name)) {
        this.notice = undefined;
        this.plugin.views.refreshOnboardingNow();
        return;
      }
    }
  }

  private async checkKey(): Promise<void> {
    const api = await agentApiForOwner(this.plugin);
    const configured = api === null ? null : await modelKeyConfigured(api).catch(() => null);
    this.unsupported = configured === null;
    this.keyNeeded = configured === null ? null : !configured;
    this.plugin.views.refreshOnboardingNow();
  }

  public async add(presetId: string, name: string, login: AgentLogin, report: (message: string) => void): Promise<void> {
    const problem = agentNameProblem(name);
    if (problem !== null) {
      report(problem);
      return;
    }
    if (login?.kind === 'local') {
      report('Claude Code on this computer is not available yet in this build.');
      return;
    }
    // The agent is added first and its login saved after: a login saved for an
    // agent the server then refuses would sit there with nobody to think with it.
    let loginSaved: string | null = null;
    try {
      const api = await agentApiForOwner(this.plugin);
      if (api === null) {
        report('Connect as the vault owner first.');
        return;
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
      if (login !== null) {
        loginSaved = await setModelKey(api, {
          provider: login.provider,
          ...(login.secret === undefined ? {} : { secret: login.secret }),
          ...(login.model === undefined ? {} : { model: login.model }),
          ...(login.baseUrl === undefined ? {} : { baseUrl: login.baseUrl }),
        });
      }
    } catch {
      report('Could not reach the server. Try again in a moment.');
      return;
    }

    // The server has the agent now, so nothing below may read as "not added".
    // Never the secret itself in a message.
    const missing: string[] = [];
    if (login !== null && loginSaved !== 'saved') {
      missing.push(loginSaved === 'invalid' ? `its login was refused (${INVALID[login.provider] ?? 'check it'})` : 'its login could not be saved');
    }
    try {
      await writeTaskNote(this.plugin, name, presetId);
    } catch {
      missing.push('its task note could not be written');
    }
    if (missing.length === 0) {
      this.notice = `${name} is joining. It appears in yellow within a minute; its task is in Havemind/Agents/${name}.md.`;
    } else {
      this.notice = `Agent added, but ${missing.join(' and ')}.`;
      report(this.notice);
    }
    this.formOpen = false;
    this.plugin.views.refreshOnboardingNow();
    void this.waitForAgent(name);
  }
}
