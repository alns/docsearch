import { describe, expect, it } from 'vitest';
import { createAgenticSearch } from '../src/agent.js';
import { StubLlmAdapter } from '../src/llm/stubAdapter.js';
import { collect, doneEvent, freshMockProvider } from './helpers.js';

describe('multi-hop retrieval', () => {
  it('follows a cross-repo reference from a product doc to a strategy doc, and cites both', async () => {
    // product-docs/campaigns/budgets.md links to strategy/budget-governance.md ("Budget
    // Governance Model") — the two live in different sections entirely. The query below is
    // deliberately about budgets.md's own content only (pacing/rounding, unique to that doc);
    // it never mentions governance. The agent must read the first doc, notice the in-body
    // reference, and read the second before answering — the hop is driven by what it found,
    // not by the question already naming the destination.
    const agent = createAgenticSearch({ provider: freshMockProvider(), llm: new StubLlmAdapter() });
    const events = await collect(
      agent.ask('How does daily pacing work, and how are rounding remainders handled for campaign budgets?'),
    );

    const done = doneEvent(events);
    expect(done).toBeDefined();

    const urls = done!.citations.map((c) => c.url).sort();
    expect(urls).toEqual(
      ['/docs/campaigns/budgets/', 'https://wiki.internal.example.com/strategy/budget-governance'].sort(),
    );

    const statusSteps = events.filter((e) => e.type === 'status').map((e) => (e as { step: string }).step);
    expect(statusSteps.some((s) => s.startsWith('reading:') && s.includes('Campaign Budgets'))).toBe(true);
    expect(statusSteps.some((s) => s.startsWith('reading:') && s.includes('Budget Governance Model'))).toBe(true);
  });
});
