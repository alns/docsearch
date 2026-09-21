# Agentic Documentation Search

A standalone, contract-first agent that answers natural-language questions
over a documentation corpus by iteratively searching and reading through an
injected `DocProvider` — no prebuilt index, no crawling, no vector DB. The
host implements `DocProvider` against its own content store; everything
here develops and tests against a mock.

## Quick start

```bash
npm install
npm test          # 14 tests: grounding, refusal, caps, multi-hop, cancellation
npm run ask -- ask "How do campaigns handle budget increases, and where's the governance model that approves them?"
```

The CLI runs against the sample corpus in `fixtures/docs/` using the
deterministic `StubLlmAdapter` by default — no API key required. Pass
`--gemini --model <id>` (with `GEMINI_API_KEY` set) to run it against a real
Gemini model instead, or `--docs <dir>` to point at a different folder of
markdown files.

## The contract (`src/contract.ts`)

```ts
interface DocProvider {
  search(query: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<DocHit[]>;
  read(id: string, opts?: { signal?: AbortSignal }): Promise<Doc | null>;
  list(section?: string, opts?: { signal?: AbortSignal }): Promise<DocSummary[]>;
  resolveRef?(ref: string, opts?: { signal?: AbortSignal }): Promise<DocSummary | null>; // optional
}

interface LlmAdapter {
  streamChat(params: { messages: LlmMessage[]; tools: LlmToolDef[]; signal?: AbortSignal }): AsyncIterable<LlmStreamEvent>;
}

function createAgenticSearch(deps: { provider: DocProvider; llm: LlmAdapter; options?: AgentOptions }): {
  ask(question: string, opts?: { history?: {role:'user'|'assistant';content:string}[]; signal?: AbortSignal }): AsyncIterable<AskEvent>;
};
```

This is the entire integration surface. A host wires in its own
`DocProvider` (against its real store) and `LlmAdapter` (against its real
model SDK) and gets a working agent with zero changes to `src/agent.ts`.

**`resolveRef` is optional.** It resolves an in-body link's text to the doc
it points at, for exact multi-hop follow-up. When a provider doesn't
implement it, the agent falls back to `search()` on the link's text — most
descriptive anchor text still finds the right doc.

**`signal` is threaded through every provider method** and into
`llm.streamChat`, so a host that can cancel an in-flight request (an
abortable fetch, a cancellable query) gets real cancellation, not just a
local stop.

## Architecture

The agent loop (`src/agent.ts`) is an adaptive ReAct loop: the model
alternates between tool calls (`search_docs`, `read_doc`, `list_docs`, and
`resolve_reference` when the provider supports it) and reasoning, up to
`maxIterations` turns. This was chosen over two more rigid alternatives — a
fixed plan→retrieve→synthesize pipeline, and a single fan-out-search +
one-shot-synthesis pass — because both fail the target use case's own
example question ("how do X campaigns handle budget, and where's the
governance model?"): the second half is typically answered by *reading* the
first doc and following a reference it contains, which only an adaptive
loop can react to.

**Budgets.** `maxToolCalls` and `maxReadChars` are hard caps tracked across
the whole session. When either is exhausted — or `maxIterations` is about
to run out — the next request to the model omits `tools` entirely, forcing
a text-only synthesis turn instead of erroring or looping forever. The
model is told once, via an injected system note, that the budget is spent
and to answer with what it already has. The loop always terminates in
exactly one `done` or `error` event.

**Grounding is enforced in code, not just prompted.** The system prompt
requires the model to mark every claim with `[^doc:ID]`, where `ID` is a
doc id it actually passed to `read_doc`. `src/citations.ts` strips these
markers from the visible answer and keeps only the ones whose ID is in the
session's read-set — a marker citing a doc the agent never read is silently
dropped, never trusted. This makes "no citation without a read" a testable
invariant (`tests/grounding.test.ts`) instead of a prompting convention.

**Streaming.** Text from a turn that goes on to call a tool is buffered and
discarded (it's mid-reasoning, not the answer); only a turn that ends with
no tool calls is treated as final and streamed to the caller as `token`
events. This trades true token-by-token streaming of the very first draft
for a guarantee that nothing shown to the user is later invalidated by a
tool call the model decides to make after all.

## Package layout

```
src/
  contract.ts             Doc/DocProvider/LlmAdapter/AgentOptions/AskEvent — the integration boundary
  agent.ts                createAgenticSearch: the ReAct loop, budgets, streaming
  citations.ts             [^doc:ID] marker enforcement (streaming-safe)
  providers/mockDocProvider.ts   reference DocProvider over a folder of markdown files
  llm/stubAdapter.ts       deterministic, corpus-aware LlmAdapter for tests and the CLI
  llm/geminiAdapter.ts     concrete LlmAdapter for Gemini function-calling + streaming
  cli.ts                   `ask "<question>"` demo
fixtures/docs/             7-doc sample corpus (4 sections, one cross-link) for tests/demo
tests/                     grounding, refusal, caps, multi-hop, cancellation
```

## Tests

```bash
npm test
```

- **`grounding.test.ts`** — unit tests on the marker filter (keeps a marker
  for a read doc, drops one for an unread doc, de-dupes, survives a marker
  split across streaming chunks) plus an end-to-end check that every
  citation traces back to a doc that was actually read.
- **`refusal.test.ts`** — a query with no relevant corpus match produces a
  refusal with zero citations and zero `read_doc` calls.
- **`caps.test.ts`** — `maxToolCalls`, `maxIterations`, and `maxReadChars`
  are never exceeded, and the agent always still reaches `done`, never
  `error`, when a cap cuts retrieval short.
- **`multihop.test.ts`** — the budgets→governance cross-link in the sample
  corpus is followed, and both docs end up cited.
- **`cancellation.test.ts`** — aborting before or mid-loop stops further
  provider calls and always yields exactly one terminal event
  (`{ type: 'error', message: 'cancelled' }`).

## Swapping in a real content store

Implement `DocProvider` against your own store — `search` needs some form
of lookup (full-text, a search API, even a simple linear scan over titles
for a small corpus), `read` needs to fetch one doc by the id your `search`
returned, and `list` needs to enumerate docs (optionally by section). None
of `src/agent.ts` changes. `MockDocProvider` (`src/providers/mockDocProvider.ts`)
is a complete worked example if useful as a reference.

## Swapping in a real model

`GeminiLlmAdapter` (`src/llm/geminiAdapter.ts`) is the concrete integration
target, talking to Gemini's `streamGenerateContent` SSE endpoint directly
(no SDK dependency). Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) and pass a
model id explicitly — model ids change over time, so none is hardcoded as a
default beyond the CLI's own `--model` flag.
