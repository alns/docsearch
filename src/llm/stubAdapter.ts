import { randomUUID } from 'node:crypto';
import type { LlmAdapter, LlmMessage, LlmStreamEvent, LlmToolDef } from '../contract.js';

const DEFAULT_REFUSAL = 'The retrieved docs do not answer this question.';
const STEP_DELAY_MS = 1;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toolMessagesByName(messages: LlmMessage[], name: string): LlmMessage[] {
  return messages.filter((m) => m.role === 'tool' && m.name === name);
}

function safeParse<T>(content: string, fallback: T): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

function firstMarkdownLink(body: string): { text: string; href: string } | undefined {
  const m = body.match(/\[([^\]]+)\]\(([^)]+)\)/);
  if (!m) return undefined;
  return { text: m[1]!, href: m[2]! };
}

function firstSentence(text: string): string {
  const withoutHeadings = text.replace(/^#{1,6}\s+.*$/gm, ' ');
  const flat = withoutHeadings.replace(/\s+/g, ' ').trim();
  const m = flat.match(/^.*?[.!?](?=\s|$)/);
  return (m?.[0] ?? flat).slice(0, 240);
}

interface ReadResult {
  id?: string;
  title?: string;
  body?: string;
  error?: string;
}

/**
 * Deterministic, corpus-aware stand-in for a real tool-calling model: a pure
 * function of (messages, tools), no network calls, no randomness. Used for
 * the required tests (grounding, refusal, caps, multi-hop, cancellation) and
 * as the default engine for the CLI demo when no real adapter is configured.
 *
 * Policy: search once; if nothing relevant comes back, refuse. Otherwise
 * read the top hit; if its body contains a markdown link and no doc has
 * been read yet, follow it (via resolve_reference when offered, else a
 * search on the link text) for one hop; then synthesize an answer from
 * every doc actually read, citing each with [^doc:ID]. When the agent
 * offers no tools (a forced final turn), it always synthesizes instead of
 * attempting a tool call.
 */
export class StubLlmAdapter implements LlmAdapter {
  async *streamChat(params: {
    messages: LlmMessage[];
    tools: LlmToolDef[];
    signal?: AbortSignal;
  }): AsyncIterable<LlmStreamEvent> {
    const { messages, tools, signal } = params;
    await delay(STEP_DELAY_MS);
    if (signal?.aborted) return;

    const hasTools = tools.length > 0;
    const last = messages[messages.length - 1];
    const readsSoFar = toolMessagesByName(messages, 'read_doc').length;

    if (hasTools && last?.role === 'user') {
      yield* this.callTool('search_docs', { query: last.content });
      return;
    }

    if (hasTools && last?.role === 'tool' && last.name === 'search_docs') {
      const hits = safeParse<{ id: string }[]>(last.content, []);
      if (hits.length === 0) {
        yield* this.finalText(readsSoFar === 0 ? DEFAULT_REFUSAL : this.synthesize(messages));
        return;
      }
      yield* this.callTool('read_doc', { id: hits[0]!.id });
      return;
    }

    if (hasTools && last?.role === 'tool' && last.name === 'resolve_reference') {
      const resolved = safeParse<{ id?: string }>(last.content, {});
      yield* resolved.id
        ? this.callTool('read_doc', { id: resolved.id })
        : this.finalText(this.synthesize(messages));
      return;
    }

    if (hasTools && last?.role === 'tool' && last.name === 'read_doc') {
      const result = safeParse<ReadResult>(last.content, {});
      if (!result.error && result.body && readsSoFar === 1) {
        const link = firstMarkdownLink(result.body);
        if (link) {
          const canResolveRef = tools.some((t) => t.name === 'resolve_reference');
          yield* canResolveRef
            ? this.callTool('resolve_reference', { ref: link.text })
            : this.callTool('search_docs', { query: link.text });
          return;
        }
      }
      yield* this.finalText(this.synthesize(messages));
      return;
    }

    yield* this.finalText(this.synthesize(messages));
  }

  private synthesize(messages: LlmMessage[]): string {
    const reads = toolMessagesByName(messages, 'read_doc')
      .map((m) => safeParse<ReadResult>(m.content, {}))
      .filter((r): r is Required<Pick<ReadResult, 'id' | 'body'>> & ReadResult => !!r.id && !!r.body && !r.error);

    if (reads.length === 0) return DEFAULT_REFUSAL;
    return reads.map((r) => `${firstSentence(r.body!)} [^doc:${r.id}]`).join(' ');
  }

  private async *callTool(name: string, args: Record<string, unknown>): AsyncIterable<LlmStreamEvent> {
    yield { type: 'tool-call', toolCall: { id: randomUUID(), name, arguments: JSON.stringify(args) } };
    yield { type: 'end', finishReason: 'tool-calls' };
  }

  private async *finalText(text: string): AsyncIterable<LlmStreamEvent> {
    for (const chunk of text.split(/(?<=\s)/)) {
      yield { type: 'text-delta', text: chunk };
    }
    yield { type: 'end', finishReason: 'stop' };
  }
}
