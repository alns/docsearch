#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { createAgenticSearch } from './agent.js';
import { MockDocProvider } from './providers/mockDocProvider.js';
import { StubLlmAdapter } from './llm/stubAdapter.js';
import { GeminiLlmAdapter } from './llm/geminiAdapter.js';
import type { LlmAdapter } from './contract.js';

const DEFAULT_DOCS_DIR = fileURLToPath(new URL('../fixtures/docs', import.meta.url));

function parseArgs(argv: string[]) {
  const args = [...argv];
  let docsDir = DEFAULT_DOCS_DIR;
  let useGemini = false;
  let model = 'gemini-2.0-flash';
  const positional: string[] = [];

  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === '--docs') docsDir = args.shift() ?? docsDir;
    else if (arg === '--gemini') useGemini = true;
    else if (arg === '--model') model = args.shift() ?? model;
    else positional.push(arg);
  }
  return { docsDir, useGemini, model, positional };
}

async function main(): Promise<void> {
  const { docsDir, useGemini, model, positional } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;

  if (command !== 'ask' || rest.length === 0) {
    console.error('Usage: ask "<question>" [--docs <dir>] [--gemini] [--model <id>]');
    process.exitCode = 1;
    return;
  }
  const question = rest.join(' ');

  const provider = new MockDocProvider(docsDir);
  let llm: LlmAdapter;
  if (useGemini) {
    llm = new GeminiLlmAdapter({ model });
  } else {
    llm = new StubLlmAdapter();
  }

  const agent = createAgenticSearch({ provider, llm });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());

  for await (const event of agent.ask(question, { signal: controller.signal })) {
    switch (event.type) {
      case 'status':
        process.stderr.write(`… ${event.step}\n`);
        break;
      case 'token':
        process.stdout.write(event.text);
        break;
      case 'done':
        process.stdout.write('\n\n');
        if (event.citations.length > 0) {
          console.log('Sources:');
          for (const c of event.citations) console.log(`  - ${c.title} — ${c.url}`);
        }
        break;
      case 'error':
        console.error(`\nError: ${event.message}`);
        process.exitCode = 1;
        break;
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
