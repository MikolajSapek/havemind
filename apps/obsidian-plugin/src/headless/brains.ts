/**
 * What an agent thinks with (plan 016), from the saved brain: provider, model,
 * endpoint, and its login kept apart. One factory for the agents service on
 * the server and for an agent run on the owner's own computer.
 */

import { createCliOneShot, createOpenAiCompatibleOneShot } from './claude-code';
import { createClaudeModel, DEFAULT_AGENT_MODEL } from './model';
import type { AgentBrain } from './runner';

export type BrainProvider = 'claude-code' | 'codex' | 'cursor' | 'anthropic' | 'openai-compatible';

export interface BrainOptions {
  /** Where the CLI lives when it is not on PATH (the agents service installs Claude Code). */
  readonly bin?: string;
}

export interface BrainConfig {
  readonly provider: BrainProvider;
  readonly model?: string;
  readonly baseUrl?: string;
}

/** Null when the brain cannot run: an API that needs a key has none. */
export function brainFrom(config: BrainConfig, secret: string | null, options: BrainOptions = {}): AgentBrain | null {
  const model = {
    ...(config.model === undefined || config.model === '' ? {} : { model: config.model }),
    ...(options.bin === undefined ? {} : { bin: options.bin }),
  };
  const login = secret === null || secret === '' ? {} : { secret };
  switch (config.provider) {
    case 'claude-code':
    case 'codex':
    case 'cursor':
      return { kind: 'one-shot', ask: createCliOneShot(config.provider, { ...model, ...login }) };
    case 'anthropic':
      if (secret === null || secret === '') return null;
      return { kind: 'tools', model: createClaudeModel({ apiKey: secret, model: config.model ?? DEFAULT_AGENT_MODEL }) };
    case 'openai-compatible':
      if (config.baseUrl === undefined || config.model === undefined) return null;
      return {
        kind: 'one-shot',
        ask: createOpenAiCompatibleOneShot({ baseUrl: config.baseUrl, model: config.model, ...(secret === null ? {} : { apiKey: secret }) }),
      };
    default:
      return null;
  }
}

export function parseBrain(text: string | null): BrainConfig | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<BrainConfig>;
    const providers: readonly string[] = ['claude-code', 'codex', 'cursor', 'anthropic', 'openai-compatible'];
    if (typeof value.provider !== 'string' || !providers.includes(value.provider)) return null;
    return {
      provider: value.provider,
      ...(typeof value.model === 'string' ? { model: value.model } : {}),
      ...(typeof value.baseUrl === 'string' ? { baseUrl: value.baseUrl } : {}),
    };
  } catch {
    return null;
  }
}
