# Agentic Documentation Search

A standalone, contract-first agent that answers natural-language questions
over a documentation corpus by iteratively searching and reading through an
injected `DocProvider` — no prebuilt index, no crawling, no vector DB. The
host implements `DocProvider` against its own content store; everything
here develops and tests against a mock.

## Quick start

```bash
npm install
npm test          # 27 tests: grounding, refusal, caps, multi-hop, cancellation, section filtering, streaming, Gemini adapter
npm run ask -- ask "How does daily pacing work, and how are rounding remainders handled for campaign budgets?"
```

The CLI runs against the sample corpus in `fixtures/docs/` using the
deterministic `StubLlmAdapter` by default — no API key required. Pass
`--gemini --model <id>` (with `GEMINI_API_KEY` set) to run it against a real
Gemini model instead, or `--docs <dir>` to point at a different folder of
markdown files.

## The contract (`src/contract.ts`)

```ts
interface DocProvider {
  search(query: string, opts?: { limit?: number; section?: string; signal?: AbortSignal }): Promise<DocHit[]>;
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

**Streaming.** A forced-final turn (`tools=[]` offered — the last iteration,
or retrieval budget already spent) can't legitimately produce a tool call,
so that's known *before* the turn runs, not just after: its `text-delta`s
are pushed through `CitationFilter` and forwarded as `token` events live,
as the model generates them. An ambiguous turn (tools were offered, and the
model might still choose to answer directly instead of calling one) can't
stream live — whether it's final is only knowable once it ends with zero
tool calls, so its text is buffered and, if it does turn out to be final,
emitted afterward. This keeps the one guarantee that matters — nothing
shown to the user is later invalidated by a tool call the model decides to
make after all — while giving up nothing when it isn't at risk. See
`tests/streaming.test.ts` for a test that proves genuine pass-through (not
word-boundary re-chunking) on the forced-final path.

If a non-compliant adapter still emits a `tool-call` event during a
forced-final turn (no tools were ever offered to call), it's ignored, not
executed — acting on it would mean invoking the provider with an id that
was never validated against a real tool schema. And a forced-final turn
that produces no text at all (a model that generates nothing, or produces
only an ignored bogus tool-call) falls back to a fixed, non-empty
`EMPTY_ANSWER_FALLBACK` string rather than emitting a blank `done` answer.

## Federating multiple content sources

If the docs actually live in several repos with different audiences or
purposes (user-facing product docs, internal strategy docs upstream of
requirements, internal team-process docs), route between them with two
additive, non-breaking pieces — no change to the loop itself:

1. **A federating `DocProvider`.** Write one wrapper that composes N
   per-repo providers: `search()`/`list()` fan out to each and merge
   results, tagging every hit and summary with `section` (the repo it came
   from — `DocHit.section` exists for exactly this). This is the *only*
   place multi-repo-ness exists; the agent still sees one `DocProvider`.
2. **Section descriptions in the system prompt.** `search_docs` returning a
   `section` label tells the model *where* a hit came from, but not what
   that section is *for* — two repos can use similar vocabulary for
   different things ("budget" in a how-to vs. in a policy rationale doc).
   Put a one-line description of each section's purpose in
   `AgentOptions.systemPrompt`; `src/cli.ts`'s `SECTION_DESCRIPTIONS`
   constant is a working example against this repo's three-section corpus.

`search_docs` also takes an optional `section` argument the model can use
to narrow a call once it has a specific reason to. **Don't go further and
hard-route the whole question to one repo before retrieval starts.** That
would need to guess the right repo with less information than the agent
has after even one read, and it breaks the thing this architecture is
built for: a question can legitimately need a fact from one repo and
rationale from another, discovered only by following a reference — the
same mechanism as a same-repo multi-hop, just crossing a section boundary
(see `tests/multihop.test.ts`, where `product-docs/campaigns/budgets.md`
links to `strategy/budget-governance.md`). Let the model search unscoped
by default and narrow only when confident; never pre-classify and gate.

Authorization is a different problem from routing and isn't handled here:
if different callers should see different sections at all (not just be
routed between ones they can all see), that's enforced by constructing a
different federating `DocProvider` per caller/audience *before* the agent
is built — never inside the loop, and never left to the model's judgment.

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
fixtures/docs/             7-doc sample corpus across 3 sections (product-docs, strategy, team-docs)
                           with a cross-repo link, for tests/demo
tests/                     grounding, refusal, caps, multi-hop, cancellation, section filtering,
                           streaming, Gemini adapter request construction
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
- **`multihop.test.ts`** — a cross-*repo* link (product-docs → strategy) in
  the sample corpus is followed, and both docs end up cited, driven by the
  reference the agent found rather than by the question naming both topics.
- **`cancellation.test.ts`** — aborting before or mid-loop stops further
  provider calls and always yields exactly one terminal event
  (`{ type: 'error', message: 'cancelled' }`).
- **`sections.test.ts`** — `MockDocProvider.search` tags hits with their
  section and honors a `section` filter; the agent forwards a model's
  `section` argument through to the provider unchanged.
- **`streaming.test.ts`** — a forced-final turn forwards `text-delta`s
  live rather than re-chunking a buffered string; a turn with no text
  falls back to a non-empty refusal instead of an empty `done`; a
  non-compliant adapter's tool-call during a forced-final turn is ignored
  and never reaches the provider.
- **`geminiAdapter.test.ts`** — request construction against a mocked
  `fetch`: the API key goes in a header, never the URL; `generationConfig`
  carries a default `maxOutputTokens` and passes through `temperature`;
  Vertex AI mode builds the right URL and sends a bearer token instead of
  an API key; `toGeminiContents` groups one turn's parallel tool results
  into a single content block instead of one per result.

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
(no SDK dependency). Two auth modes:

- **API-key (default).** Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), or pass
  `apiKey` directly. The key goes in an `x-goog-api-key` header, not the URL
  query string, so it doesn't end up in proxy or server access logs.
- **Vertex AI.** Pass `vertex: { project, location, getAccessToken }`
  instead of `apiKey`. Token acquisition (Application Default Credentials,
  a service account, workload identity, …) is inherently
  environment-specific, so this module takes no dependency on a Google auth
  library for it — the host supplies a function that returns a fresh token,
  and owns its own caching/refresh.

A model id must always be passed explicitly (`model`) — none is hardcoded
as a default, since model ids change over time; the CLI's own `--model`
flag is the example. `generationConfig` is always sent, with
`maxOutputTokens` defaulting to 4096 (override via `maxOutputTokens`) so a
long answer isn't silently truncated by whatever the API's own default
happens to be; `temperature` is passed through when set.

`toGeminiContents` groups all of one turn's tool results into a single
Gemini content block (parallel function-calling responses need to be
batched together per Gemini's documented convention, not sent as separate
turns) — covered by a direct unit test in `tests/geminiAdapter.test.ts`.
Request construction (URL, headers, `generationConfig`, content mapping)
is tested against a mocked `fetch`; none of it has been exercised against
the live Gemini API from within this environment (no credentials here), so
treat a first real call as the actual verification, not this test suite.
