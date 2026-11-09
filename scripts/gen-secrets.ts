#!/usr/bin/env node
/** Writes the random secrets deploy/.env needs. Never overwrites an existing value. */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECRET_KEYS = [
  'TELEGRAM_WEBHOOK_SECRET',
  'OME_ADMISSION_SECRET',
  'OME_API_TOKEN',
  'SERVER_HMAC_KEY',
  'FORWARD_AUTH_SECRET',
  'GATE_AGENT_TOKEN',
] as const;

export function fillSecrets(envText: string, gen: () => string = () => randomBytes(32).toString('base64url')): string {
  const lines = envText.split(/\r?\n/);
  const present = new Set<string>();
  const outLines = lines.map((line) => {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m || !m[1]) return line;
    present.add(m[1]);
    if ((SECRET_KEYS as readonly string[]).includes(m[1]) && (m[2] ?? '').trim() === '') return `${m[1]}=${gen()}`;
    return line;
  });
  for (const key of SECRET_KEYS) if (!present.has(key)) outLines.push(`${key}=${gen()}`);
  return outLines.join('\n').replace(/\n*$/, '\n');
}

function main(): void {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const envPath = join(root, 'deploy', '.env');
  const base = existsSync(envPath) ? readFileSync(envPath, 'utf8') : readFileSync(join(root, 'deploy', '.env.example'), 'utf8');
  writeFileSync(envPath, fillSecrets(base), { mode: 0o600 });
  console.info(`gen-secrets: wrote ${envPath} (existing values kept)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
