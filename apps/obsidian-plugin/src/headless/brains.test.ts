import { describe, expect, it } from 'vitest';

import { brainFrom, parseBrain } from './brains';

describe('what an agent thinks with (plan 016)', () => {
  it('runs Claude Code in one answer, with or without a server-side login', () => {
    expect(brainFrom({ provider: 'claude-code' }, null)?.kind).toBe('one-shot');
    expect(brainFrom({ provider: 'claude-code', model: 'm' }, 'secret')?.kind).toBe('one-shot');
  });

  it('never runs Codex or Cursor from a saved brain: they can read the whole disk (plan 018 item 9)', () => {
    for (const provider of ['codex', 'cursor'] as const) {
      expect(brainFrom({ provider }, 'secret')).toBeNull();
      expect(parseBrain(JSON.stringify({ provider }))).toBeNull();
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
    expect(parseBrain('{"provider":"claude-code","model":"m"}')).toEqual({ provider: 'claude-code', model: 'm' });
    expect(parseBrain('{"provider":"nope"}')).toBeNull();
    expect(parseBrain('not json')).toBeNull();
    expect(parseBrain(null)).toBeNull();
  });
});
