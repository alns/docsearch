import { describe, expect, it } from 'vitest';
import { createAgenticSearch } from '../src/agent.js';
import { StubLlmAdapter } from '../src/llm/stubAdapter.js';
import { stripCitationMarkers, CitationFilter } from '../src/citations.js';
import type { DocSummary } from '../src/contract.js';
import { collect, doneEvent, freshMockProvider } from './helpers.js';

describe('citation marker enforcement (unit)', () => {
  const readSet = new Map<string, DocSummary>([
    ['campaigns/budgets', { id: 'campaigns/budgets', title: 'Campaign Budgets', url: '/docs/campaigns/budgets/' }],
  ]);

  it('keeps a marker for a doc that was actually read', () => {
    const { text, citations } = stripCitationMarkers('Budgets pause at 100%. [^doc:campaigns/budgets]', readSet);
    expect(text.trim()).toBe('Budgets pause at 100%.');
    expect(citations).toEqual([{ title: 'Campaign Budgets', url: '/docs/campaigns/budgets/' }]);
  });

  it('drops a marker for a doc id that was never read', () => {
    const { text, citations } = stripCitationMarkers('Made up fact. [^doc:not/a/real/doc]', readSet);
    expect(text.trim()).toBe('Made up fact.');
    expect(citations).toEqual([]);
  });

  it('de-duplicates repeated citations of the same doc, in first-appearance order', () => {
    const { citations } = stripCitationMarkers(
      'A [^doc:campaigns/budgets] and B [^doc:campaigns/budgets]',
      readSet,
    );
    expect(citations).toHaveLength(1);
  });

  it('handles a marker split across streaming chunks', () => {
    const filter = new CitationFilter(readSet);
    let out = '';
    out += filter.push('Spend pauses at 100%. [^doc:campa');
    out += filter.push('igns/budgets] Done.');
    out += filter.finish().trailing;
    expect(out).toBe('Spend pauses at 100%.  Done.');
    expect(filter.citations()).toEqual([{ title: 'Campaign Budgets', url: '/docs/campaigns/budgets/' }]);
  });
});

describe('agent grounding (end-to-end, mock provider + stub adapter)', () => {
  it('only emits citations for docs it actually read via read_doc', async () => {
    // targeting.md has no outbound links, so the stub adapter answers from a single read — a
    // clean case for asserting every citation traces back to exactly the doc that was read.
    const agent = createAgenticSearch({ provider: freshMockProvider(), llm: new StubLlmAdapter() });
    const events = await collect(agent.ask('What targeting dimensions are available for an ad set?'));
    const done = doneEvent(events);
    expect(done).toBeDefined();
    expect(done!.citations.length).toBeGreaterThan(0);
    for (const citation of done!.citations) {
      expect(citation.url).toBe('/docs/campaigns/targeting/');
    }
    // the raw marker syntax must never leak into the visible answer
    expect(done!.answer).not.toMatch(/\[\^doc:/);
  });
});
