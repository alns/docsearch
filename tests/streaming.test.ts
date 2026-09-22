import { describe, expect, it } from 'vitest';
import { createAgenticSearch, EMPTY_ANSWER_FALLBACK } from '../src/agent.js';
import type { LlmAdapter, LlmStreamEvent } from '../src/contract.js';
import { collect, doneEvent, freshMockProvider, withCallCounter } from './helpers.js';

function adapterOf(events: LlmStreamEvent[]): LlmAdapter {
  return {
    async *streamChat() {
      for (const ev of events) yield ev;
    },
  };
}

describe('live streaming on a forced-final turn', () => {
  it('passes text-deltas straight through as they arrive, not re-chunked by word boundary', async () => {
    // These three chunks are deliberately NOT split on whitespace ("Hel" | "lo wor" | "ld.") —
    // word-boundary re-chunking (the old finalize()/chunkWords path) could never reproduce
    // this exact 3-piece shape from "Hello world.", so seeing it back proves the deltas were
    // forwarded live rather than buffered whole and re-split afterward.
    const llm = adapterOf([
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo wor' },
      { type: 'text-delta', text: 'ld.' },
      { type: 'end', finishReason: 'stop' },
    ]);
    const agent = createAgenticSearch({
      provider: freshMockProvider(),
      llm,
      options: { maxIterations: 1 }, // forces the very first turn to be a no-tools, forced-final turn
    });

    const events = await collect(agent.ask('anything'));
    const tokens = events.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text);

    expect(tokens).toEqual(['Hel', 'lo wor', 'ld.']);
    expect(doneEvent(events)).toEqual({ type: 'done', answer: 'Hello world.', citations: [] });
  });
});

describe('forced-final turn edge cases', () => {
  it('falls back to a non-empty refusal instead of an empty done answer when the model emits no text', async () => {
    const llm = adapterOf([{ type: 'end', finishReason: 'stop' }]);
    const agent = createAgenticSearch({
      provider: freshMockProvider(),
      llm,
      options: { maxIterations: 1 },
    });

    const events = await collect(agent.ask('anything'));
    const done = doneEvent(events);
    expect(done).toBeDefined();
    expect(done!.answer).toBe(EMPTY_ANSWER_FALLBACK);
    expect(done!.answer.length).toBeGreaterThan(0);
    expect(done!.citations).toEqual([]);
  });

  it('ignores a tool-call from a non-compliant adapter when no tools were offered, and still uses the streamed text', async () => {
    const { provider, counts } = withCallCounter(freshMockProvider());
    const llm = adapterOf([
      { type: 'text-delta', text: 'Partial answer.' },
      // Illegitimate: tools=[] was passed for this turn, so no tool was ever offered to call.
      { type: 'tool-call', toolCall: { id: 'x', name: 'search_docs', arguments: '{"query":"x"}' } },
      { type: 'end', finishReason: 'tool-calls' },
    ]);
    const agent = createAgenticSearch({
      provider,
      llm,
      options: { maxIterations: 1 },
    });

    const events = await collect(agent.ask('anything'));
    const done = doneEvent(events);
    expect(done).toBeDefined();
    expect(done!.answer).toBe('Partial answer.');
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(counts.search).toBe(0); // the bogus tool-call must never reach the provider
  });
});
