import type { Citation, DocSummary } from './contract.js';

// Grounding is enforced here, not just prompted: the model is instructed to
// mark every factual claim with `[^doc:ID]`, where ID is a doc id it
// actually retrieved via read_doc. Markers whose ID is NOT in the caller's
// read set are dropped rather than trusted — "citations only for docs you
// actually read" is a code-level invariant, not a prompting convention.

const MARKER_PREFIX = '[^doc:';

/**
 * Strips `[^doc:ID]` markers from a complete text, keeping only those whose
 * ID is in `readSet`, and returns the visible text plus the ordered,
 * de-duplicated citation list (in first-appearance order).
 */
export function stripCitationMarkers(
  text: string,
  readSet: ReadonlyMap<string, DocSummary>,
): { text: string; citations: Citation[] } {
  const filter = new CitationFilter(readSet);
  const visible = filter.push(text) + filter.finish().trailing;
  return { text: visible, citations: filter.citations() };
}

/**
 * Streaming-safe marker filter: consumes text chunks as they arrive from the
 * LLM and returns only text that is definitely not part of an in-progress
 * marker, holding back a small tail until a marker either completes (and is
 * resolved/dropped) or turns out not to be a marker at all.
 */
export class CitationFilter {
  private pending = '';
  private seen = new Set<string>();
  private order: Citation[] = [];

  constructor(private readonly readSet: ReadonlyMap<string, DocSummary>) {}

  push(chunk: string): string {
    const combined = this.pending + chunk;
    let emit = '';
    let i = 0;

    for (;;) {
      const openIdx = combined.indexOf(MARKER_PREFIX, i);
      if (openIdx === -1) {
        const safeEnd = trailingPartialMarkerStart(combined, i);
        emit += combined.slice(i, safeEnd);
        this.pending = combined.slice(safeEnd);
        return emit;
      }
      emit += combined.slice(i, openIdx);
      const closeIdx = combined.indexOf(']', openIdx);
      if (closeIdx === -1) {
        this.pending = combined.slice(openIdx);
        return emit;
      }
      const id = combined.slice(openIdx + MARKER_PREFIX.length, closeIdx);
      this.record(id);
      i = closeIdx + 1;
    }
  }

  /** Call once the stream ends; flushes any trailing text that never completed a marker. */
  finish(): { trailing: string } {
    const trailing = this.pending;
    this.pending = '';
    return { trailing };
  }

  citations(): Citation[] {
    return this.order;
  }

  private record(id: string): void {
    if (this.seen.has(id)) return;
    const doc = this.readSet.get(id);
    if (!doc) return; // not a doc we actually read — dropped, never trusted
    this.seen.add(id);
    this.order.push({ title: doc.title, url: doc.url });
  }
}

function trailingPartialMarkerStart(s: string, from: number): number {
  const max = Math.min(MARKER_PREFIX.length - 1, s.length - from);
  for (let len = max; len >= 1; len--) {
    const suffix = s.slice(s.length - len);
    if (suffix === MARKER_PREFIX.slice(0, len)) {
      return s.length - len;
    }
  }
  return s.length;
}
