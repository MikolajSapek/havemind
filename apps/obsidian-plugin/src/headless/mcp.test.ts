import { Readable, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { HeadlessAgent } from './agent';
import { handleMcpMessage, serveMcp } from './mcp';

function fakeAgent() {
  const writeNote = vi.fn(async () => undefined);
  const agent = {
    identity: { name: 'Bot', vaultName: 'V' },
    sync: async () => ({}),
    readNote: async (path: string) => (path === 'Havemind/Agents/Bot.md' ? '---\nmay_write: [Notes]\n---\nDo it.' : null),
    listNotes: async () => [],
    writeNote,
  } as unknown as HeadlessAgent;
  return { agent, writeNote };
}

const call = (args: Record<string, unknown>) => ({
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'tools/call',
  params: { name: 'write_note', arguments: args },
});

describe('write_note over MCP (plan 018 item 7)', () => {
  it('refuses content that is not a string instead of emptying the note', async () => {
    const { agent, writeNote } = fakeAgent();
    const reply = await handleMcpMessage(agent, call({ path: 'Notes/a.md' }));
    expect((reply?.result as { isError?: boolean }).isError).toBe(true);
    expect(writeNote).not.toHaveBeenCalled();
  });

  it('still writes a note with real content', async () => {
    const { agent, writeNote } = fakeAgent();
    await handleMcpMessage(agent, call({ path: 'Notes/a.md', content: 'hi' }));
    expect(writeNote).toHaveBeenCalledWith('Notes/a.md', 'hi');
  });
});

describe('odd JSON-RPC input (plan 018 item 12e)', () => {
  it('survives a JSON null line and answers the next message', async () => {
    const { agent } = fakeAgent();
    let out = '';
    const output = new Writable({
      write(chunk, _enc, done) {
        out += String(chunk);
        done();
      },
    });
    const input = Readable.from(['null\n', '42\n', '[]\n', '{"jsonrpc":"2.0","id":9,"method":"ping"}\n']);
    await serveMcp(agent, input, output);
    expect(out).toContain('"id":9');
  });
});
