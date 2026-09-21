import { describe, expect, it } from 'vitest';
import { createAgenticSearch } from '../src/agent.js';
import { StubLlmAdapter } from '../src/llm/stubAdapter.js';
import { collect, doneEvent, freshMockProvider } from './helpers.js';

describe('refusal on unanswerable questions', () => {
  it('refuses with no citations when nothing in the corpus is relevant', async () => {
    const agent = createAgenticSearch({ provider: freshMockProvider(), llm: new StubLlmAdapter() });
    const events = await collect(agent.ask('postgresql connection pooling pgbouncer configuration'));

    const done = doneEvent(events);
    expect(done).toBeDefined();
    expect(done!.citations).toEqual([]);
    expect(done!.answer.length).toBeGreaterThan(0);

    // must never have attempted to read a doc it had no relevant hit for
    const readAttempts = events.filter((e) => e.type === 'status' && e.step.startsWith('reading:'));
    expect(readAttempts).toHaveLength(0);
  });
});
