import { describe, expect, it } from 'vitest';

import { brainFrom, parseBrain } from './brains';

describe('what an agent thinks with (plan 016)', () => {
  it('runs a coding CLI in one answer, with or without a server-side login', () => {
    for (const provider of ['claude-code', 'codex', 'cursor'] as const) {
      expect(brainFrom({ provider }, null)?.kind).toBe('one-shot');
      expect(brainFrom({ provider, model: 'm' }, 'secret')?.kind).toBe('one-shot');
    }
  });

  it('uses the API with tools for an Anthropic key, and needs the key', () => {
    expect(brainFrom({ provider: 'anthropic' }, 'sk-ant-api03-x')?.kind).toBe('tools');
    expect(brainFrom({ provider: 'anthropic' }, null)).toBeNull();
  });

  it('asks any OpenAI-compatible endpoint once it has a URL and a model', () => {
    expect(brainFrom({ provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'llama3' }, null)?.kind).toBe('one-shot');
    expect(brainFrom({ provider: 'openai-compatible', model: 'x' }, 'k')).toBeNull();
  });

  it('reads only known providers from the saved brain', () => {
    expect(parseBrain('{"provider":"codex","model":"gpt-5-codex"}')).toEqual({ provider: 'codex', model: 'gpt-5-codex' });
    expect(parseBrain('{"provider":"nope"}')).toBeNull();
    expect(parseBrain('not json')).toBeNull();
    expect(parseBrain(null)).toBeNull();
  });
});
