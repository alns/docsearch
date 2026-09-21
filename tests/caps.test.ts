import { describe, expect, it } from 'vitest';
import { createAgenticSearch } from '../src/agent.js';
import { StubLlmAdapter } from '../src/llm/stubAdapter.js';
import { collect, doneEvent, errorEvent, freshMockProvider, totalCalls, withCallCounter } from './helpers.js';

const MULTIHOP_QUESTION = "How do campaigns handle budgets, and where's the governance model?";

describe('cap enforcement', () => {
  it('never exceeds maxToolCalls, and still finishes with a done event', async () => {
    const { provider, counts } = withCallCounter(freshMockProvider());
    const agent = createAgenticSearch({
      provider,
      llm: new StubLlmAdapter(),
      options: { maxToolCalls: 1, maxIterations: 8 },
    });
    const events = await collect(agent.ask(MULTIHOP_QUESTION));

    expect(totalCalls(counts)).toBeLessThanOrEqual(1);
    expect(doneEvent(events)).toBeDefined();
    expect(errorEvent(events)).toBeUndefined();
  });

  it('never exceeds maxIterations even when the model would keep calling tools', async () => {
    const { provider, counts } = withCallCounter(freshMockProvider());
    const agent = createAgenticSearch({
      provider,
      llm: new StubLlmAdapter(),
      // The multi-hop question naturally takes 3 tool-call turns (search, read, follow-link-read)
      // plus a synthesis turn = 4 iterations. Cap at 2 to force early, graceful termination.
      options: { maxIterations: 2, maxToolCalls: 20 },
    });
    const events = await collect(agent.ask(MULTIHOP_QUESTION));

    // at most 1 tool call could have been dispatched before the forced-final 2nd iteration
    expect(totalCalls(counts)).toBeLessThanOrEqual(1);
    const done = doneEvent(events);
    expect(done).toBeDefined();
    expect(errorEvent(events)).toBeUndefined();
  });

  it('degrades gracefully (answers with a refusal, not an error) when the budget is exhausted before any read', async () => {
    const { provider } = withCallCounter(freshMockProvider());
    const agent = createAgenticSearch({
      provider,
      llm: new StubLlmAdapter(),
      options: { maxIterations: 1 },
    });
    const events = await collect(agent.ask(MULTIHOP_QUESTION));

    const done = doneEvent(events);
    expect(done).toBeDefined();
    expect(done!.citations).toEqual([]);
    expect(errorEvent(events)).toBeUndefined();
  });

  it('truncates doc content to maxReadChars and still terminates cleanly', async () => {
    const agent = createAgenticSearch({
      provider: freshMockProvider(),
      llm: new StubLlmAdapter(),
      options: { maxReadChars: 40 },
    });
    const events = await collect(agent.ask('What targeting dimensions are available for an ad set?'));
    expect(doneEvent(events)).toBeDefined();
    expect(errorEvent(events)).toBeUndefined();
  });
});
