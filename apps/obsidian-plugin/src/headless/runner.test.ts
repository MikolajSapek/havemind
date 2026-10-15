import { describe, expect, it, vi } from 'vitest';

import type { HeadlessAgent } from './agent';
import type { ModelPort } from './model';
import { runAgentOnce } from './runner';

const TASK = '---\nmay_write: [Notes]\nevery: 1h\n---\nFile things.';

function fakeAgent(over: { sync?: () => Promise<unknown>; writeNote?: (path: string, content: string) => Promise<void> } = {}) {
  const writeNote = vi.fn(over.writeNote ?? (async () => undefined));
  const agent = {
    identity: { name: 'Bot', vaultName: 'V' },
    sync: over.sync ?? (async () => ({})),
    readNote: async (path: string) => (path === 'Havemind/Agents/Bot.md' ? TASK : 'text'),
    listNotes: async () => ['Inbox/a.md'],
    peopleChangesSince: async () => ({ latest: 7, paths: ['Inbox/a.md'], authors: {} }),
    writeNote,
  } as unknown as HeadlessAgent;
  return { agent, writeNote };
}

const START = { lastRunAt: 0, lastSequence: 0 };

/** A sync that works once (the start of the run) and then fails. */
function syncFailingAfterFirst() {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls > 1) throw new Error('network down');
    return {};
  };
}

/** A model that calls write_note once with `input`, then ends; keeps what it was told. */
function writingModel(input: Record<string, unknown>): { model: ModelPort; results: () => unknown } {
  let last: unknown;
  let turn = 0;
  const model: ModelPort = async (request) => {
    turn += 1;
    last = request.messages[request.messages.length - 1]?.content;
    if (turn === 1) {
      return { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'write_note', input }] };
    }
    return { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
  };
  return { model, results: () => last };
}

describe('write_note input checks (plan 018 item 7)', () => {
  it('refuses a write whose content is not a string instead of emptying the note', async () => {
    const { agent, writeNote } = fakeAgent();
    const { model, results } = writingModel({ path: 'Notes/a.md', content: 42 });
    const outcome = await runAgentOnce({ agent, model, memory: START, now: 1000 });
    expect(writeNote).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('done');
    expect(JSON.stringify(results())).toContain('is_error');
  });

  it('refuses a write whose path is not a string', async () => {
    const { agent, writeNote } = fakeAgent();
    const { model } = writingModel({ content: 'x' });
    await runAgentOnce({ agent, model, memory: START, now: 1000 });
    expect(writeNote).not.toHaveBeenCalled();
  });
});

describe('a failing final sync (plan 018 item 8)', () => {
  it('still returns the outcome with the spent memory', async () => {
    const { agent } = fakeAgent({ sync: syncFailingAfterFirst() });
    const { model } = writingModel({ path: 'Notes/a.md', content: 'x' });
    const outcome = await runAgentOnce({ agent, model, memory: START, now: 5000 });
    expect(outcome.kind).toBe('done');
    expect(outcome.memory).toMatchObject({ lastRunAt: 5000, lastSequence: 7, runsToday: 1 });
    expect(outcome.kind === 'done' && outcome.summary).toContain('sync');
    expect(JSON.stringify(outcome)).not.toContain('network down');
  });

  it('also returns a failed outcome when the model and the sync both throw', async () => {
    const { agent } = fakeAgent({ sync: syncFailingAfterFirst() });
    const model: ModelPort = async () => {
      throw new Error('model down');
    };
    const outcome = await runAgentOnce({ agent, model, memory: START, now: 5000 });
    expect(outcome.kind).toBe('failed');
    expect(outcome.memory).toMatchObject({ lastRunAt: 5000, runsToday: 1 });
  });
});

describe('one throwing tool (plan 018 item 12a)', () => {
  it('does not abort the run: the model is told the write failed', async () => {
    const { agent } = fakeAgent({
      writeNote: async () => {
        throw new Error('EISDIR: /secret/path');
      },
    });
    const { model, results } = writingModel({ path: 'Notes/a.md', content: 'x' });
    const outcome = await runAgentOnce({ agent, model, memory: START, now: 1000 });
    expect(outcome.kind).toBe('done');
    expect(JSON.stringify(results())).toContain('is_error');
    expect(JSON.stringify(results())).not.toContain('/secret/path');
  });

  it('keeps going in the one-shot path, listing the write as refused', async () => {
    const { agent } = fakeAgent({
      writeNote: async () => {
        throw new Error('ENOTDIR');
      },
    });
    const ask = async () => '{"writes":[{"path":"Notes/a.md","content":"x"}],"summary":"s"}';
    const outcome = await runAgentOnce({ agent, brain: { kind: 'one-shot', ask }, memory: START, now: 1000 });
    expect(outcome.kind).toBe('done');
    expect(outcome.kind === 'done' && outcome.summary).toContain('refused');
  });
});

describe('model text stays out of errors (plan 018 item 12b)', () => {
  it('reports a fixed message when the answer is not JSON', async () => {
    const { agent } = fakeAgent();
    const ask = async () => '{"writes": SECRET-NOTE-TEXT}';
    const outcome = await runAgentOnce({ agent, brain: { kind: 'one-shot', ask }, memory: START, now: 1000 });
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.error).not.toContain('SECRET');
  });
});
