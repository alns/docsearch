// Integration boundary for the agentic documentation search module.
// The host implements DocProvider and LlmAdapter against its own content
// store and model SDK; the agent loop (src/agent.ts) only ever talks to
// these interfaces.

// ---------------------------------------------------------------------------
// Content model
// ---------------------------------------------------------------------------

export interface Doc {
  id: string; // stable unique id (opaque to the agent)
  title: string;
  url: string; // canonical link to emit as a citation (e.g. "/docs/…/")
  section?: string; // top-level grouping/source label
  path?: string; // human-readable breadcrumb
  body: string; // full text (markdown or plain)
  updatedAt?: string; // ISO 8601
}

export interface DocHit {
  id: string;
  title: string;
  url: string;
  snippet: string;
  score?: number;
  section?: string; // which source/repo this hit came from — federated providers should always set this
}

export interface DocSummary {
  id: string;
  title: string;
  url: string;
  section?: string;
}

/**
 * Injected dependency — the ONLY way the agent reaches content. The host
 * implements this against its own store; a reference MockDocProvider is
 * provided for local development and tests. The agent never bypasses it.
 */
export interface DocProvider {
  /**
   * `opts.section`, when present, restricts the search to one source/repo
   * (as also used by `list`). Optional on both sides: a provider may ignore
   * it (returning unscoped results), and the agent never requires it — it's
   * a precision lever the model can reach for, not a routing gate.
   */
  search(query: string, opts?: { limit?: number; section?: string; signal?: AbortSignal }): Promise<DocHit[]>;
  read(id: string, opts?: { signal?: AbortSignal }): Promise<Doc | null>;
  list(section?: string, opts?: { signal?: AbortSignal }): Promise<DocSummary[]>;
  /**
   * Optional capability: resolve an in-body reference (a markdown link's
   * href/anchor text, or a relative path found in a doc's body) to the doc
   * it points at, for exact multi-hop follows. When absent, the agent falls
   * back to search(ref) — most descriptive link text still finds the doc.
   */
  resolveRef?(ref: string, opts?: { signal?: AbortSignal }): Promise<DocSummary | null>;
}

// ---------------------------------------------------------------------------
// LLM adapter — tool-calling, streaming chat completion
// ---------------------------------------------------------------------------

export interface LlmToolDef {
  name: string;
  description: string;
  /** JSON Schema object describing the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON-encoded arguments, as emitted by the model. */
  arguments: string;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on an assistant message that invokes one or more tools. */
  toolCalls?: LlmToolCall[];
  /** Present on a tool-role message: which call this result answers. */
  toolCallId?: string;
  /** Present on a tool-role message: the tool name that was invoked. */
  name?: string;
}

export type LlmStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolCall: LlmToolCall }
  | { type: 'end'; finishReason: 'stop' | 'tool-calls' | 'length' | 'error' };

/**
 * Minimal adapter over a tool-calling, streaming chat model. Implementations
 * translate LlmMessage/LlmToolDef into the target SDK's request shape and
 * translate the response stream back into LlmStreamEvent.
 */
export interface LlmAdapter {
  streamChat(params: {
    messages: LlmMessage[];
    tools: LlmToolDef[];
    signal?: AbortSignal;
  }): AsyncIterable<LlmStreamEvent>;
}

// ---------------------------------------------------------------------------
// Public agent API
// ---------------------------------------------------------------------------

export interface AgentOptions {
  /** Hard cap on agent loop turns (LLM round-trips, tool-call or text-only alike). */
  maxIterations?: number;
  /** Hard cap on total DocProvider calls across the whole session. */
  maxToolCalls?: number;
  /** Cap on cumulative characters of doc content pulled into context via read_doc. */
  maxReadChars?: number;
  /** Host-supplied grounding/citation/refusal rules, prepended to the agent's own system prompt. */
  systemPrompt?: string;
}

export interface Citation {
  title: string;
  url: string;
}

export type AskEvent =
  | { type: 'status'; step: string } // progress: "searching: …", "reading: <title>"
  | { type: 'token'; text: string } // streamed answer text
  | { type: 'done'; answer: string; citations: Citation[] } // terminal: success
  | { type: 'error'; message: string }; // terminal: failure

export interface AgenticSearch {
  ask(
    question: string,
    opts?: {
      history?: { role: 'user' | 'assistant'; content: string }[];
      signal?: AbortSignal;
    },
  ): AsyncIterable<AskEvent>;
}

export interface AgenticSearchDeps {
  provider: DocProvider;
  llm: LlmAdapter;
  options?: AgentOptions;
}
