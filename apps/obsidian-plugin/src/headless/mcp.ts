/**
 * The agent as an MCP server over stdio (plan 014, the second way to run an
 * agent): Claude Code, Claude Desktop or any MCP client drives it, through
 * the same scoped write path the background runner uses. Newline-delimited
 * JSON-RPC 2.0, the MCP stdio transport; no SDK, so no new dependency.
 */

import type { HeadlessAgent } from './agent';
import { writeAsAgent } from './runner';
import { parseTaskNote, taskNotePath, type AgentTask } from './task-note';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: number | string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: 'my_task',
    description: "This agent's task note: what it is for and the folders it may write in.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_notes',
    description: 'Lists every Markdown note in the shared vault (synced first).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_note',
    description: 'Returns the text of one note.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_note',
    description:
      "Creates or replaces one note and syncs it, signed as this agent. Only inside the task note's folders.",
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
] as const;

function text(value: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

async function readTask(agent: HeadlessAgent): Promise<AgentTask | null> {
  const note = await agent.readNote(taskNotePath(agent.identity.name));
  return note === null ? null : parseTaskNote(note);
}

async function callTool(agent: HeadlessAgent, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const path = typeof args.path === 'string' ? args.path : '';
  switch (name) {
    case 'my_task': {
      await agent.sync();
      const note = await agent.readNote(taskNotePath(agent.identity.name));
      return note === null
        ? text(`No task note yet. The owner writes it at ${taskNotePath(agent.identity.name)}.`)
        : text(note);
    }
    case 'list_notes':
      await agent.sync();
      return text((await agent.listNotes()).join('\n'));
    case 'read_note': {
      const note = await agent.readNote(path);
      return note === null ? text(`No note at ${path}.`, true) : text(note);
    }
    case 'write_note': {
      await agent.sync();
      const task = await readTask(agent);
      if (task === null) return text('Refused: this agent has no task note, so no folder to write in.', true);
      const refusal = await writeAsAgent(agent, task, path, typeof args.content === 'string' ? args.content : '');
      if (refusal !== null) return text(`Refused: ${refusal}`, true);
      await agent.sync();
      return text(`Saved and synced ${path}.`);
    }
    default:
      return text(`Unknown tool ${name}.`, true);
  }
}

/** Answers one JSON-RPC message; null for a notification (no reply). */
export async function handleMcpMessage(agent: HeadlessAgent, message: JsonRpcRequest): Promise<Record<string, unknown> | null> {
  if (message.id === undefined) return null;
  const reply = (result: Record<string, unknown>) => ({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize':
      return reply({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: `havemind-agent (${agent.identity.name})`, version: '1' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const params = message.params ?? {};
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        return reply(await callTool(agent, name, args));
      } catch (error) {
        return reply(text(`Failed: ${error instanceof Error ? error.message : 'unknown error'}`, true));
      }
    }
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } };
  }
}

/** Serves MCP on stdin/stdout until stdin closes. Nothing else may write to stdout. */
export async function serveMcp(agent: HeadlessAgent, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
  let buffer = '';
  for await (const chunk of input) {
    buffer += chunk.toString();
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line === '') continue;
      let message: JsonRpcRequest;
      try {
        message = JSON.parse(line) as JsonRpcRequest;
      } catch {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
        continue;
      }
      const response = await handleMcpMessage(agent, message);
      if (response !== null) output.write(`${JSON.stringify(response)}\n`);
    }
  }
}
