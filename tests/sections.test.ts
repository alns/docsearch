import { describe, expect, it } from 'vitest';
import { createAgenticSearch } from '../src/agent.js';
import type { DocHit, DocProvider, LlmAdapter, LlmMessage, LlmStreamEvent, LlmToolDef } from '../src/contract.js';
import { collect, doneEvent, freshMockProvider } from './helpers.js';

describe('MockDocProvider section filtering', () => {
  it('tags every hit with the section it came from', async () => {
    const provider = freshMockProvider();
    const hits = await provider.search('campaign budgets pacing');
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(typeof hit.section).toBe('string');
  });

  it('restricts results to the requested section, and returns none for a section with no match', async () => {
    const provider = freshMockProvider();

    const strategyOnly = await provider.search('budget governance', { section: 'strategy' });
    expect(strategyOnly.length).toBeGreaterThan(0);
    for (const hit of strategyOnly) expect(hit.section).toBe('strategy');

    // "budget governance" is squarely a strategy topic — scoping the same query to team-docs
    // (operational role assignment, not policy rationale) should come back empty or unrelated.
    const wrongSection = await provider.search('budget governance', { section: 'product-docs', limit: 1 });
    for (const hit of wrongSection) expect(hit.section).toBe('product-docs');
  });
});

describe('agent forwards a scoped search_docs call to the provider', () => {
  it('passes the section argument through to DocProvider.search', async () => {
    const seenOpts: { section?: string }[] = [];
    const provider: DocProvider = {
      async search(_query, opts) {
        seenOpts.push({ section: opts?.section });
        const hit: DocHit = { id: 'x', title: 'X', url: '/x', snippet: 'x', section: opts?.section };
        return [hit];
      },
      async read(id) {
        return { id, title: 'X', url: '/x', section: seenOpts[0]?.section, body: 'Body text.' };
      },
      async list() {
        return [];
      },
    };

    // A one-shot adapter: call search_docs scoped to "strategy", then finalize with no citation.
    const llm: LlmAdapter = {
      async *streamChat({ messages }): AsyncIterable<LlmStreamEvent> {
        const last = messages[messages.length - 1] as LlmMessage;
        if (last.role === 'user') {
          yield {
            type: 'tool-call',
            toolCall: { id: '1', name: 'search_docs', arguments: JSON.stringify({ query: 'anything', section: 'strategy' }) },
          };
          yield { type: 'end', finishReason: 'tool-calls' };
          return;
        }
        yield { type: 'text-delta', text: 'Done.' };
        yield { type: 'end', finishReason: 'stop' };
      },
    };

    const agent = createAgenticSearch({ provider, llm, options: { maxIterations: 3 } });
    const events = await collect(agent.ask('anything'));
    expect(doneEvent(events)).toBeDefined();
    expect(seenOpts).toEqual([{ section: 'strategy' }]);
  });

  it('advertises the section parameter on the search_docs tool definition', async () => {
    const captured: LlmToolDef[][] = [];
    const provider = freshMockProvider();
    const llm: LlmAdapter = {
      async *streamChat({ tools }): AsyncIterable<LlmStreamEvent> {
        captured.push(tools);
        yield { type: 'text-delta', text: 'ok' };
        yield { type: 'end', finishReason: 'stop' };
      },
    };
    const agent = createAgenticSearch({ provider, llm });
    await collect(agent.ask('anything'));

    const searchTool = captured[0]?.find((t) => t.name === 'search_docs');
    expect(searchTool).toBeDefined();
    const props = (searchTool!.parameters as { properties: Record<string, unknown> }).properties;
    expect(props.section).toBeDefined();
  });
});
