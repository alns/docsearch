import { randomUUID } from 'node:crypto';
import type { LlmAdapter, LlmMessage, LlmStreamEvent, LlmToolDef } from '../contract.js';

export interface GeminiVertexOptions {
  project: string;
  location: string; // e.g. "us-central1"
  /**
   * Supplies a fresh access token per request. This module takes no dependency on Google auth
   * libraries — token acquisition (Application Default Credentials, a service account,
   * workload identity, …) is inherently environment-specific, so the host owns it and is
   * responsible for its own caching/refresh.
   */
  getAccessToken: () => Promise<string>;
}

export interface GeminiAdapterOptions {
  /** Model id, e.g. "gemini-2.0-flash". Pass explicitly — model ids change over time. */
  model: string;
  /** API-key mode (default). Defaults to process.env.GEMINI_API_KEY (or GOOGLE_API_KEY). */
  apiKey?: string;
  /** Vertex AI mode: pass this instead of `apiKey` to call Vertex AI rather than the public API. */
  vertex?: GeminiVertexOptions;
  /** Overrides the API base URL. Defaults per mode (public Generative Language API vs. a regional Vertex endpoint). */
  baseUrl?: string;
  /** Sampling temperature, passed through to generationConfig when set. */
  temperature?: number;
  /** Caps response length; defaults to 4096 to avoid a long answer being silently truncated. */
  maxOutputTokens?: number;
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
 * Supports both the public API-key endpoint and Vertex AI.
 */
export class GeminiLlmAdapter implements LlmAdapter {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly temperature: number | undefined;
  private readonly maxOutputTokens: number;
  private readonly mode: 'api-key' | 'vertex';
  private readonly apiKey?: string;
  private readonly vertex?: GeminiVertexOptions;

  constructor(opts: GeminiAdapterOptions) {
    this.model = opts.model;
    this.temperature = opts.temperature;
    this.maxOutputTokens = opts.maxOutputTokens ?? 4096;

    if (opts.vertex) {
      this.mode = 'vertex';
      this.vertex = opts.vertex;
      this.baseUrl = opts.baseUrl ?? `https://${opts.vertex.location}-aiplatform.googleapis.com/v1`;
    } else {
      const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
      if (!apiKey) {
        throw new Error(
          'GeminiLlmAdapter requires an API key (opts.apiKey, GEMINI_API_KEY, or GOOGLE_API_KEY) or opts.vertex for Vertex AI mode.',
        );
      }
      this.mode = 'api-key';
      this.apiKey = apiKey;
      this.baseUrl = opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    }
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

    const generationConfig: Record<string, unknown> = { maxOutputTokens: this.maxOutputTokens };
    if (this.temperature !== undefined) generationConfig.temperature = this.temperature;

    const body: Record<string, unknown> = { contents, generationConfig };
    if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
    if (tools.length > 0) {
      body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
    }

    const { url, headers } = await this.buildRequest();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
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

  private async buildRequest(): Promise<{ url: string; headers: Record<string, string> }> {
    if (this.mode === 'vertex') {
      const { project, location, getAccessToken } = this.vertex!;
      const token = await getAccessToken();
      const url = `${this.baseUrl}/projects/${project}/locations/${location}/publishers/google/models/${this.model}:streamGenerateContent?alt=sse`;
      return { url, headers: { authorization: `Bearer ${token}` } };
    }
    // Key goes in a header, not the URL query string — a query-string key can end up in proxy
    // and server access logs; a header is the documented, log-safe way to send it.
    const url = `${this.baseUrl}/models/${this.model}:streamGenerateContent?alt=sse`;
    return { url, headers: { 'x-goog-api-key': this.apiKey! } };
  }
}

export function toGeminiContents(messages: LlmMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  let pendingToolParts: GeminiPart[] = [];

  const flushToolParts = () => {
    if (pendingToolParts.length === 0) return;
    // Gemini expects all functionResponses answering one turn's (possibly parallel)
    // functionCalls grouped into a single content block, not one block per response.
    contents.push({ role: 'user', parts: pendingToolParts });
    pendingToolParts = [];
  };

  for (const m of messages) {
    if (m.role === 'system') continue; // folded into systemInstruction
    if (m.role === 'tool') {
      pendingToolParts.push({ functionResponse: { name: m.name ?? 'unknown', response: { result: safeJson(m.content) } } });
      continue;
    }
    flushToolParts();
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const call of m.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: safeJson(call.arguments) } });
      }
      contents.push({ role: 'model', parts });
    }
  }
  flushToolParts();
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
