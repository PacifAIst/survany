#!/usr/bin/env node
/**
 * Runs the provider bench for the providers named on the command line, merging into the existing
 * reports (other providers' results are kept). Cross-platform, unlike an inline environment variable.
 *   pnpm bench:provider openrouter        (needs OPENROUTER_API_KEY in the environment)
 *   pnpm bench:provider local
 * Then `pnpm bench` renders docs/BENCHMARKS.md.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ids = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (ids.length === 0) {
  console.error('usage: pnpm bench:provider <provider id> [more ids]   (ids as in bench/providers.json)');
  process.exit(2);
}
const vitest = join(dirname(createRequire(join(root, 'package.json')).resolve('vitest/package.json')), 'vitest.mjs');
const r = spawnSync(process.execPath, [vitest, 'run', '-c', 'bench/vitest.config.ts'], { cwd: root, stdio: 'inherit', env: { ...process.env, BENCH_PROVIDERS: ids.join(',') } });
process.exit(r.status ?? 1);
