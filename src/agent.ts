import type {
  AgenticSearch,
  AgenticSearchDeps,
  AgentOptions,
  AskEvent,
  DocProvider,
  DocSummary,
  LlmMessage,
  LlmToolCall,
  LlmToolDef,
} from './contract.js';
import { CitationFilter, stripCitationMarkers } from './citations.js';

const DEFAULT_OPTIONS: Required<AgentOptions> = {
  maxIterations: 8,
  maxToolCalls: 12,
  maxReadChars: 20_000,
  systemPrompt: '',
};

// Last-resort text when a forced-final turn produces no usable content at all (a model that
// generates nothing, or a non-compliant adapter whose only output was a tool-call we refuse to
// act on since no tools were offered). Never surfaced when the model produces any real text.
export const EMPTY_ANSWER_FALLBACK = 'No answer was generated from the retrieved information.';

const CORE_INSTRUCTIONS = `
You are a documentation search assistant. Answer only using information retrieved via the search_docs, read_doc, and list_docs tools (and resolve_reference, when offered). Never use prior knowledge and never invent facts, doc titles, or URLs.

Mark every factual claim drawn from a retrieved doc with a citation marker immediately after it, in the exact form [^doc:ID], where ID is exactly the id you passed to read_doc for that doc. One marker per claim. Never fabricate an ID, and never cite a doc you have not read with read_doc.

If the retrieved docs do not answer the question, say so plainly instead of guessing.
`.trim();

const BUDGET_EXHAUSTED_NOTE =
  'Retrieval budget is exhausted. No more tool calls are available. Answer now using only what you have already retrieved, citing it with [^doc:ID] markers, or say plainly that the docs you found do not answer the question.';

function buildToolDefs(provider: DocProvider): LlmToolDef[] {
  const tools: LlmToolDef[] = [
    {
      name: 'search_docs',
      description:
        'Search the documentation corpus for candidate docs matching a query. Returns id, title, url, section, and a snippet for each hit. The corpus spans multiple sections (sources) with different purposes — see the system prompt for what each one covers.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language or keyword search query.' },
          limit: { type: 'integer', description: 'Maximum number of hits to return.' },
          section: {
            type: 'string',
            description:
              'Optional: restrict the search to one section/source when you are confident which one the answer lives in. Omit to search across all sections — prefer omitting unless you have a specific reason to narrow.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'read_doc',
      description:
        'Read the full content of a specific doc by id, as returned by search_docs or list_docs. You must read a doc before citing it.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
    {
      name: 'list_docs',
      description:
        'List doc titles and ids, optionally filtered by section. Use when search does not surface the right doc, or to explore the corpus structure.',
      parameters: {
        type: 'object',
        properties: { section: { type: 'string' } },
      },
    },
  ];
  if (provider.resolveRef) {
    tools.push({
      name: 'resolve_reference',
      description:
        'Resolve a link or reference mentioned in a doc you have already read (e.g. "see the governance model") to the doc it points to, for multi-hop follow-up.',
      parameters: {
        type: 'object',
        properties: { ref: { type: 'string' } },
        required: ['ref'],
      },
    });
  }
  return tools;
}

class Cancelled extends Error {}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Cancelled();
}

interface ToolCtx {
  provider: DocProvider;
  signal: AbortSignal | undefined;
  readSet: Map<string, DocSummary>;
  toolCallsUsed: number;
  readCharsUsed: number;
  maxToolCalls: number;
  maxReadChars: number;
}

type ToolResult = unknown;

async function executeTool(call: LlmToolCall, ctx: ToolCtx): Promise<{ result: ToolResult; status: string }> {
  if (ctx.toolCallsUsed >= ctx.maxToolCalls) {
    return { result: { error: 'retrieval budget exhausted' }, status: 'budget exhausted' };
  }

  let args: Record<string, unknown>;
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    return { result: { error: 'invalid arguments' }, status: `invalid arguments for ${call.name}` };
  }

  ctx.toolCallsUsed++;

  try {
    switch (call.name) {
      case 'search_docs': {
        const query = String(args.query ?? '');
        const limit = typeof args.limit === 'number' ? args.limit : undefined;
        const section = typeof args.section === 'string' ? args.section : undefined;
        const hits = await ctx.provider.search(query, { limit, section, signal: ctx.signal });
        return { result: hits, status: section ? `searching "${section}": "${query}"` : `searching: "${query}"` };
      }
      case 'read_doc': {
        const id = String(args.id ?? '');
        const remaining = ctx.maxReadChars - ctx.readCharsUsed;
        if (remaining <= 0) {
          return {
            result: { error: 'read budget exhausted; synthesize with what you have' },
            status: `reading: ${id} (budget exhausted)`,
          };
        }
        const doc = await ctx.provider.read(id, { signal: ctx.signal });
        if (!doc) {
          return { result: { error: 'not found' }, status: `reading: ${id} (not found)` };
        }
        const truncated = doc.body.length > remaining;
        const body = truncated ? `${doc.body.slice(0, remaining)}\n…[truncated]` : doc.body;
        ctx.readCharsUsed += body.length;
        ctx.readSet.set(doc.id, { id: doc.id, title: doc.title, url: doc.url, section: doc.section });
        return {
          result: { id: doc.id, title: doc.title, url: doc.url, section: doc.section, path: doc.path, body, truncated },
          status: `reading: ${doc.title}`,
        };
      }
      case 'list_docs': {
        const section = typeof args.section === 'string' ? args.section : undefined;
        const summaries = await ctx.provider.list(section, { signal: ctx.signal });
        return { result: summaries, status: `listing: ${section ?? 'all sections'}` };
      }
      case 'resolve_reference': {
        if (!ctx.provider.resolveRef) {
          return { result: { error: 'unsupported' }, status: 'resolve_reference unsupported' };
        }
        const ref = String(args.ref ?? '');
        const resolved = await ctx.provider.resolveRef(ref, { signal: ctx.signal });
        return { result: resolved ?? { error: 'not found' }, status: `resolving reference: "${ref}"` };
      }
      default:
        return { result: { error: `unknown tool: ${call.name}` }, status: `unknown tool: ${call.name}` };
    }
  } catch (err) {
    if (isAbortError(err) || err instanceof Cancelled) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return { result: { error: message }, status: `${call.name} failed: ${message}` };
  }
}

function* chunkWords(text: string): Generator<string> {
  const re = /\S+\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) yield m[0];
}

export function createAgenticSearch(deps: AgenticSearchDeps): AgenticSearch {
  const { provider, llm } = deps;
  const options: Required<AgentOptions> = { ...DEFAULT_OPTIONS, ...deps.options };
  const toolDefs = buildToolDefs(provider);

  async function* ask(
    question: string,
    opts?: { history?: { role: 'user' | 'assistant'; content: string }[]; signal?: AbortSignal },
  ): AsyncIterable<AskEvent> {
    const signal = opts?.signal;

    try {
      throwIfAborted(signal);

      const systemPrompt = [CORE_INSTRUCTIONS, options.systemPrompt.trim()].filter(Boolean).join('\n\n');
      const messages: LlmMessage[] = [
        { role: 'system', content: systemPrompt },
        ...(opts?.history ?? []).map((m) => ({ role: m.role, content: m.content }) as LlmMessage),
        { role: 'user', content: question },
      ];

      const ctx: ToolCtx = {
        provider,
        signal,
        readSet: new Map(),
        toolCallsUsed: 0,
        readCharsUsed: 0,
        maxToolCalls: options.maxToolCalls,
        maxReadChars: options.maxReadChars,
      };

      let budgetNudged = false;

      for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
        throwIfAborted(signal);

        const forceFinal = iteration === options.maxIterations || ctx.toolCallsUsed >= ctx.maxToolCalls;
        if (forceFinal && !budgetNudged) {
          messages.push({ role: 'system', content: BUDGET_EXHAUSTED_NOTE });
          budgetNudged = true;
        }
        const tools = forceFinal ? [] : toolDefs;

        let textBuf = '';
        const toolCallsThisTurn: LlmToolCall[] = [];

        // forceFinal means tools=[] was offered, so no legitimate tool-call can occur this
        // turn — that's known up front, not just after the fact. That lets this specific turn
        // stream text-deltas straight through to the caller as they arrive, instead of
        // buffering the whole turn and re-chunking it afterward. An ambiguous turn (tools
        // offered) still can't stream live: whether it's final is only known once it ends
        // with zero tool-calls, so it keeps buffering until then.
        const liveFilter = forceFinal ? new CitationFilter(ctx.readSet) : undefined;
        let liveText = '';

        for await (const ev of llm.streamChat({ messages, tools, signal })) {
          throwIfAborted(signal);
          if (ev.type === 'text-delta') {
            if (liveFilter) {
              const safe = liveFilter.push(ev.text);
              if (safe) {
                liveText += safe;
                yield { type: 'token', text: safe };
              }
            } else {
              textBuf += ev.text;
            }
          } else if (ev.type === 'tool-call' && !forceFinal) {
            // A tool-call while forceFinal is true would come from a non-compliant adapter
            // (no tools were offered this turn) — never act on one, since it was never
            // validated against a real tool schema and executing it could mean calling the
            // provider with an arbitrary, unchecked id.
            toolCallsThisTurn.push(ev.toolCall);
          }
        }

        if (forceFinal) {
          const { trailing } = liveFilter!.finish();
          if (trailing) {
            liveText += trailing;
            yield { type: 'token', text: trailing };
          }
          const answer = liveText.trim();
          if (answer) {
            yield { type: 'done', answer, citations: liveFilter!.citations() };
          } else {
            yield* emitEmptyAnswerFallback();
          }
          return;
        }

        if (toolCallsThisTurn.length === 0) {
          yield* finalize(textBuf, ctx.readSet);
          return;
        }

        messages.push({ role: 'assistant', content: textBuf, toolCalls: toolCallsThisTurn });

        for (const call of toolCallsThisTurn) {
          throwIfAborted(signal);
          const { result, status } = await executeTool(call, ctx);
          yield { type: 'status', step: status };
          messages.push({
            role: 'tool',
            content: JSON.stringify(result),
            toolCallId: call.id,
            name: call.name,
          });
        }
      }

      // Unreachable unless maxIterations <= 0: the loop always returns via the forceFinal
      // branch on its last iteration otherwise.
      yield* emitEmptyAnswerFallback();
    } catch (err) {
      if (isAbortError(err) || err instanceof Cancelled) {
        yield { type: 'error', message: 'cancelled' };
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message };
    }
  }

  function* finalize(rawText: string, readSet: Map<string, DocSummary>): Generator<AskEvent> {
    const { text, citations } = stripCitationMarkers(rawText, readSet);
    const trimmed = text.trim();
    for (const chunk of chunkWords(trimmed)) {
      yield { type: 'token', text: chunk };
    }
    yield { type: 'done', answer: trimmed, citations };
  }

  function* emitEmptyAnswerFallback(): Generator<AskEvent> {
    yield { type: 'token', text: EMPTY_ANSWER_FALLBACK };
    yield { type: 'done', answer: EMPTY_ANSWER_FALLBACK, citations: [] };
  }

  return { ask };
}
