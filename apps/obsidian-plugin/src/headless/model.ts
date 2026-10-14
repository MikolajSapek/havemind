/**
 * The model behind an agent (plan 014): Claude's Messages API over `fetch`,
 * with tools. No SDK, so no new dependency. The API key comes from the
 * environment of the runner, never from the vault, and is never logged.
 */

export const DEFAULT_AGENT_MODEL = 'claude-sonnet-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_TOKENS = 4096;

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
  | { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string; readonly is_error?: boolean };

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly ContentBlock[];
}

export interface ModelRequest {
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolSpec[];
}

export interface ModelResponse {
  readonly content: readonly ContentBlock[];
  readonly stopReason: string;
}

/** One model turn. Injected, so tests run with a stub and never reach the network. */
export type ModelPort = (request: ModelRequest) => Promise<ModelResponse>;

export class ModelError extends Error {
  override readonly name = 'ModelError';
}

export function createClaudeModel(options: { apiKey: string; model?: string }): ModelPort {
  const model = options.model ?? DEFAULT_AGENT_MODEL;
  return async (request) => {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': options.apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system: request.system,
        tools: request.tools,
        messages: request.messages,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await response.json().catch(() => null)) as
      | { content?: ContentBlock[]; stop_reason?: string; error?: { type?: string; message?: string } }
      | null;
    if (!response.ok || body === null || !Array.isArray(body.content)) {
      // The status and the API's own error type only: a body could echo input.
      throw new ModelError(`The model call failed (${response.status}${body?.error?.type ? `, ${body.error.type}` : ''}).`);
    }
    return { content: body.content, stopReason: body.stop_reason ?? 'end_turn' };
  };
}
