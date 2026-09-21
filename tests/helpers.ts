import { fileURLToPath } from 'node:url';
import type { AskEvent, DocProvider } from '../src/contract.js';
import { MockDocProvider } from '../src/providers/mockDocProvider.js';

export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/docs', import.meta.url));

export function freshMockProvider(): MockDocProvider {
  return new MockDocProvider(FIXTURES_DIR);
}

export async function collect(events: AsyncIterable<AskEvent>): Promise<AskEvent[]> {
  const out: AskEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

export interface CallCounts {
  search: number;
  read: number;
  list: number;
  resolveRef: number;
}

/** Wraps a DocProvider to count calls, for cap-enforcement and cancellation assertions. */
export function withCallCounter(provider: DocProvider): { provider: DocProvider; counts: CallCounts } {
  const counts: CallCounts = { search: 0, read: 0, list: 0, resolveRef: 0 };
  const wrapped: DocProvider = {
    async search(query, opts) {
      counts.search++;
      return provider.search(query, opts);
    },
    async read(id, opts) {
      counts.read++;
      return provider.read(id, opts);
    },
    async list(section, opts) {
      counts.list++;
      return provider.list(section, opts);
    },
  };
  if (provider.resolveRef) {
    wrapped.resolveRef = async (ref, opts) => {
      counts.resolveRef++;
      return provider.resolveRef!(ref, opts);
    };
  }
  return { provider: wrapped, counts };
}

export function totalCalls(counts: CallCounts): number {
  return counts.search + counts.read + counts.list + counts.resolveRef;
}

export function doneEvent(events: AskEvent[]): Extract<AskEvent, { type: 'done' }> | undefined {
  return events.find((e): e is Extract<AskEvent, { type: 'done' }> => e.type === 'done');
}

export function errorEvent(events: AskEvent[]): Extract<AskEvent, { type: 'error' }> | undefined {
  return events.find((e): e is Extract<AskEvent, { type: 'error' }> => e.type === 'error');
}
