import { randomUUID } from 'node:crypto';
import type { LlmAdapter, LlmMessage, LlmStreamEvent, LlmToolDef } from '../contract.js';

export interface GeminiAdapterOptions {
  /** Defaults to process.env.GEMINI_API_KEY (or GOOGLE_API_KEY). */
  apiKey?: string;
  /** Model id, e.g. "gemini-2.0-flash". Pass explicitly — model ids change over time. */
  model: string;
  /** Defaults to the public Generative Language API. */
  baseUrl?: string;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}
interface GeminiStreamChunk {
  candidates?: {
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }[];
}

/**
 * Concrete LlmAdapter for Gemini's function-calling + streaming chat API.
 * Talks to `models/{model}:streamGenerateContent?alt=sse` directly over
 * fetch/SSE — no SDK dependency, since the LlmAdapter contract is already a
 * minimal enough surface that a thin REST mapping is simplest to audit.
 */
export class GeminiLlmAdapter implements LlmAdapter {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: GeminiAdapterOptions) {
    const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('GeminiLlmAdapter requires an API key (opts.apiKey, GEMINI_API_KEY, or GOOGLE_API_KEY).');
    }
    this.apiKey = apiKey;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  }

  async *streamChat(params: {
    messages: LlmMessage[];
    tools: LlmToolDef[];
    signal?: AbortSignal;
  }): AsyncIterable<LlmStreamEvent> {
    const { messages, tools, signal } = params;
    const systemInstruction = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .filter(Boolean)
      .join('\n\n');
    const contents = toGeminiContents(messages);

    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
    if (tools.length > 0) {
      body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
    }

    const url = `${this.baseUrl}/models/${this.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gemini request failed (${res.status}): ${text.slice(0, 500)}`);
    }

    let sawFunctionCall = false;
    let finishReason: string | undefined;

    for await (const chunk of readSseJson<GeminiStreamChunk>(res.body)) {
      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;
      for (const part of candidate.content?.parts ?? []) {
        if (part.text) {
          yield { type: 'text-delta', text: part.text };
        } else if (part.functionCall) {
          sawFunctionCall = true;
          yield {
            type: 'tool-call',
            toolCall: { id: randomUUID(), name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
          };
        }
      }
      if (candidate.finishReason) finishReason = candidate.finishReason;
    }

    yield { type: 'end', finishReason: mapFinishReason(finishReason, sawFunctionCall) };
  }
}

function toGeminiContents(messages: LlmMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // folded into systemInstruction
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const call of m.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: safeJson(call.arguments) } });
      }
      contents.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: m.name ?? 'unknown', response: { result: safeJson(m.content) } } }],
      });
    }
  }
  return contents;
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : { value: parsed };
  } catch {
    return { raw: text };
  }
}

function mapFinishReason(reason: string | undefined, sawFunctionCall: boolean): 'stop' | 'tool-calls' | 'length' | 'error' {
  if (sawFunctionCall) return 'tool-calls';
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case undefined:
      return 'stop';
    default:
      return 'error';
  }
}

/** Parses an `alt=sse` response body into successive JSON payloads. */
async function* readSseJson<T>(body: ReadableStream<Uint8Array>): AsyncIterable<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice('data:'.length).trim();
        if (!payload || payload === '[DONE]') continue;
        yield JSON.parse(payload) as T;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
