import { describe, expect, it } from 'vitest';
import { createAgenticSearch } from '../src/agent.js';
import { StubLlmAdapter } from '../src/llm/stubAdapter.js';
import { collect, freshMockProvider, totalCalls, withCallCounter } from './helpers.js';

describe('cancellation', () => {
  it('aborting before ask() starts yields a single cancelled error and makes no provider calls', async () => {
    const { provider, counts } = withCallCounter(freshMockProvider());
    const agent = createAgenticSearch({ provider, llm: new StubLlmAdapter() });
    const controller = new AbortController();
    controller.abort();

    const events = await collect(agent.ask('How are campaign budgets tracked?', { signal: controller.signal }));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'error', message: 'cancelled' });
    expect(totalCalls(counts)).toBe(0);
  });

  it('aborting mid-stream stops further provider calls and still ends with exactly one terminal event', async () => {
    const { provider, counts } = withCallCounter(freshMockProvider());
    const agent = createAgenticSearch({ provider, llm: new StubLlmAdapter() });
    const controller = new AbortController();

    const iterator = agent.ask('How are campaign budgets tracked?', { signal: controller.signal })[Symbol.asyncIterator]();

    // Let the first status event (the initial search) through, then abort before the read.
    const first = await iterator.next();
    expect(first.done).toBe(false);
    controller.abort();

    const rest = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }

    const terminal = rest.filter((e) => e.type === 'done' || e.type === 'error');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toEqual({ type: 'error', message: 'cancelled' });
    // no read_doc should have been dispatched after the abort
    expect(counts.read).toBe(0);
  });

  it('never emits both done and error', async () => {
    const agent = createAgenticSearch({ provider: freshMockProvider(), llm: new StubLlmAdapter() });
    const events = await collect(agent.ask('How are campaign budgets tracked?'));
    const terminals = events.filter((e) => e.type === 'done' || e.type === 'error');
    expect(terminals).toHaveLength(1);
  });
});
