import { describe, expect, it } from 'vitest';
import { createAgenticSearch } from '../src/agent.js';
import { StubLlmAdapter } from '../src/llm/stubAdapter.js';
import { collect, doneEvent, freshMockProvider } from './helpers.js';

describe('multi-hop retrieval', () => {
  it('follows an in-body reference from the first doc to a second, and cites both', async () => {
    // campaigns/budgets.md links to governance/model.md ("see the Governance Model") — the
    // agent must read the first doc, notice the reference, and read the second before answering.
    const agent = createAgenticSearch({ provider: freshMockProvider(), llm: new StubLlmAdapter() });
    const events = await collect(
      agent.ask("How do campaigns handle budget increases, and where's the governance model that approves them?"),
    );

    const done = doneEvent(events);
    expect(done).toBeDefined();

    const urls = done!.citations.map((c) => c.url).sort();
    expect(urls).toEqual(['/docs/campaigns/budgets/', '/docs/governance/model/'].sort());

    const statusSteps = events.filter((e) => e.type === 'status').map((e) => (e as { step: string }).step);
    expect(statusSteps.some((s) => s.startsWith('reading:') && s.includes('Campaign Budgets'))).toBe(true);
    expect(statusSteps.some((s) => s.startsWith('reading:') && s.includes('Governance Model'))).toBe(true);
  });
});
