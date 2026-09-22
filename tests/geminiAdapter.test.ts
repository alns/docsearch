import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiLlmAdapter, toGeminiContents } from '../src/llm/geminiAdapter.js';
import type { LlmMessage, LlmStreamEvent } from '../src/contract.js';

function sseBody(chunks: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

const SIMPLE_RESPONSE = [{ candidates: [{ content: { parts: [{ text: 'Hi' }] }, finishReason: 'STOP' }] }];

function mockFetch(): { fetchMock: ReturnType<typeof vi.fn>; call: () => { url: string; init: Record<string, unknown> } } {
  const fetchMock = vi.fn(async (url: string, init: Record<string, unknown>) => ({
    ok: true,
    body: sseBody(SIMPLE_RESPONSE),
    text: async () => '',
  }));
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    call: () => {
      const [url, init] = fetchMock.mock.calls[0] as [string, Record<string, unknown>];
      return { url, init };
    },
  };
}

async function drain(events: AsyncIterable<LlmStreamEvent>): Promise<void> {
  for await (const _ of events) void 0;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GeminiLlmAdapter request construction (API-key mode)', () => {
  it('sends the API key in a header, never in the URL query string', async () => {
    const { call } = mockFetch();
    const adapter = new GeminiLlmAdapter({ model: 'gemini-2.0-flash', apiKey: 'secret-key' });
    await drain(adapter.streamChat({ messages: [{ role: 'user', content: 'hi' }], tools: [] }));

    const { url, init } = call();
    expect(url).not.toContain('secret-key');
    expect(url).not.toContain('key=');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('secret-key');
  });

  it('sends a generationConfig with a default maxOutputTokens, and passes through temperature when set', async () => {
    const { call } = mockFetch();
    const adapter = new GeminiLlmAdapter({ model: 'gemini-2.0-flash', apiKey: 'k', temperature: 0.2 });
    await drain(adapter.streamChat({ messages: [{ role: 'user', content: 'hi' }], tools: [] }));

    const { init } = call();
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.maxOutputTokens).toBe(4096);
    expect(body.generationConfig.temperature).toBe(0.2);
  });

  it('respects an explicit maxOutputTokens override', async () => {
    const { call } = mockFetch();
    const adapter = new GeminiLlmAdapter({ model: 'gemini-2.0-flash', apiKey: 'k', maxOutputTokens: 512 });
    await drain(adapter.streamChat({ messages: [{ role: 'user', content: 'hi' }], tools: [] }));

    const { init } = call();
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.maxOutputTokens).toBe(512);
  });
});

describe('GeminiLlmAdapter request construction (Vertex AI mode)', () => {
  it('builds a Vertex URL and sends a bearer token instead of an API key', async () => {
    const { call } = mockFetch();
    const adapter = new GeminiLlmAdapter({
      model: 'gemini-2.0-flash',
      vertex: { project: 'my-proj', location: 'us-central1', getAccessToken: async () => 'tok-123' },
    });
    await drain(adapter.streamChat({ messages: [{ role: 'user', content: 'hi' }], tools: [] }));

    const { url, init } = call();
    expect(url).toContain('/projects/my-proj/locations/us-central1/publishers/google/models/gemini-2.0-flash:streamGenerateContent');
    expect(url).toContain('us-central1-aiplatform.googleapis.com');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-123');
    expect(headers['x-goog-api-key']).toBeUndefined();
  });
});

describe('toGeminiContents', () => {
  it('groups parallel tool-call results from one turn into a single content block', () => {
    const messages: LlmMessage[] = [
      { role: 'user', content: 'question' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: '1', name: 'search_docs', arguments: '{"query":"a"}' },
          { id: '2', name: 'search_docs', arguments: '{"query":"b"}' },
        ],
      },
      { role: 'tool', content: '[]', toolCallId: '1', name: 'search_docs' },
      { role: 'tool', content: '[]', toolCallId: '2', name: 'search_docs' },
    ];

    const contents = toGeminiContents(messages);

    // user turn, model turn (2 functionCalls), ONE grouped user turn with 2 functionResponse parts
    expect(contents).toHaveLength(3);
    expect(contents[1]?.parts).toHaveLength(2);
    expect(contents[2]?.role).toBe('user');
    expect(contents[2]?.parts).toHaveLength(2);
    expect(contents[2]?.parts.every((p) => 'functionResponse' in p)).toBe(true);
  });

  it('keeps sequential (non-parallel) tool turns as separate content blocks', () => {
    const messages: LlmMessage[] = [
      { role: 'user', content: 'question' },
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'search_docs', arguments: '{}' }] },
      { role: 'tool', content: '[]', toolCallId: '1', name: 'search_docs' },
      { role: 'assistant', content: '', toolCalls: [{ id: '2', name: 'read_doc', arguments: '{}' }] },
      { role: 'tool', content: '{}', toolCallId: '2', name: 'read_doc' },
    ];

    const contents = toGeminiContents(messages);
    expect(contents).toHaveLength(5);
    expect(contents.filter((c) => c.role === 'user' && c.parts[0] && 'functionResponse' in c.parts[0])).toHaveLength(2);
  });
});
