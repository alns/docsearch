import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { Doc, DocHit, DocProvider, DocSummary } from '../contract.js';

/**
 * Reference DocProvider backed by a local folder of markdown files with
 * optional YAML-ish frontmatter (title/section/url/path/updatedAt). Exists
 * so the agent runs and is testable with no host content store at all.
 *
 * Doc id = the file's path relative to rootDir, without extension, with
 * forward slashes (e.g. "campaigns/budgets") — opaque to the agent, stable
 * across runs.
 */
export class MockDocProvider implements DocProvider {
  private docs = new Map<string, Doc>();
  private loaded: Promise<void> | undefined;

  constructor(private readonly rootDir: string) {}

  private ensureLoaded(): Promise<void> {
    if (!this.loaded) this.loaded = this.load();
    return this.loaded;
  }

  private async load(): Promise<void> {
    const files = await walkMarkdownFiles(this.rootDir);
    for (const file of files) {
      const raw = await readFile(file, 'utf8');
      const { frontmatter, body } = parseFrontmatter(raw);
      const id = toId(this.rootDir, file);
      const title = frontmatter.title ?? deriveTitle(body) ?? id;
      const url = frontmatter.url ?? `/docs/${id}/`;
      const doc: Doc = { id, title, url, body: body.trim() };
      if (frontmatter.section) doc.section = frontmatter.section;
      if (frontmatter.path) doc.path = frontmatter.path;
      if (frontmatter.updatedAt) doc.updatedAt = frontmatter.updatedAt;
      this.docs.set(id, doc);
    }
  }

  async search(query: string, opts?: { limit?: number; section?: string; signal?: AbortSignal }): Promise<DocHit[]> {
    await this.ensureLoaded();
    const terms = tokenize(query);
    const scored: { doc: Doc; score: number }[] = [];
    for (const doc of this.docs.values()) {
      if (opts?.section && doc.section !== opts.section) continue;
      const score = scoreDoc(doc, terms);
      if (score > 0) scored.push({ doc, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const limit = opts?.limit ?? 8;
    return scored.slice(0, limit).map(({ doc, score }) => {
      const hit: DocHit = { id: doc.id, title: doc.title, url: doc.url, score, snippet: buildSnippet(doc.body, terms) };
      if (doc.section) hit.section = doc.section;
      return hit;
    });
  }

  async read(id: string): Promise<Doc | null> {
    await this.ensureLoaded();
    return this.docs.get(id) ?? null;
  }

  async list(section?: string): Promise<DocSummary[]> {
    await this.ensureLoaded();
    const all = [...this.docs.values()];
    const filtered = section ? all.filter((d) => d.section === section) : all;
    return filtered.map((d) => {
      const summary: DocSummary = { id: d.id, title: d.title, url: d.url };
      if (d.section) summary.section = d.section;
      return summary;
    });
  }

  async resolveRef(ref: string): Promise<DocSummary | null> {
    await this.ensureLoaded();
    const needle = ref.trim().toLowerCase().replace(/\.md$/i, '');
    if (!needle) return null;
    for (const doc of this.docs.values()) {
      if (matchesRef(doc, needle)) {
        const summary: DocSummary = { id: doc.id, title: doc.title, url: doc.url };
        if (doc.section) summary.section = doc.section;
        return summary;
      }
    }
    return null;
  }
}

async function walkMarkdownFiles(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkMarkdownFiles(full)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function toId(rootDir: string, file: string): string {
  return relative(rootDir, file).replace(/\.md$/i, '').split(sep).join('/');
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) return { frontmatter: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, body: raw };
  const block = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\r?\n/, '');
  const frontmatter: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key) frontmatter[key] = value;
  }
  return { frontmatter, body };
}

function deriveTitle(body: string): string | undefined {
  const match = body.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function countOccurrences(haystack: string, term: string): number {
  if (!term) return 0;
  // Whole-word match: raw substring counting would count "for" inside "platform" or
  // "before", which is noise, not relevance.
  return (haystack.match(new RegExp(`\\b${term}\\b`, 'g')) ?? []).length;
}

function scoreDoc(doc: Doc, terms: string[]): number {
  const titleLower = doc.title.toLowerCase();
  const bodyLower = doc.body.toLowerCase();
  let score = 0;
  for (const term of terms) {
    score += countOccurrences(titleLower, term) * 5;
    score += countOccurrences(bodyLower, term) * 1;
  }
  return score;
}

function buildSnippet(body: string, terms: string[]): string {
  const bodyLower = body.toLowerCase();
  let hitIndex = -1;
  for (const term of terms) {
    const idx = bodyLower.indexOf(term);
    if (idx !== -1 && (hitIndex === -1 || idx < hitIndex)) hitIndex = idx;
  }
  const window = 160;
  if (hitIndex === -1) {
    const flat = body.replace(/\s+/g, ' ').trim();
    return flat.length > window ? `${flat.slice(0, window)}…` : flat;
  }
  const start = Math.max(0, hitIndex - window / 2);
  const end = Math.min(body.length, hitIndex + window / 2);
  const flat = body.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${flat}${end < body.length ? '…' : ''}`;
}

function matchesRef(doc: Doc, needle: string): boolean {
  const titleLower = doc.title.toLowerCase();
  const urlLower = doc.url.toLowerCase();
  const pathLower = doc.path?.toLowerCase() ?? '';
  const idLower = doc.id.toLowerCase();
  return (
    titleLower === needle ||
    titleLower.includes(needle) ||
    needle.includes(titleLower) ||
    urlLower.includes(needle) ||
    pathLower.includes(needle) ||
    idLower.includes(needle.replace(/\s+/g, '-'))
  );
}
