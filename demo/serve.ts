#!/usr/bin/env node
// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Serves the demo page on http://localhost:8099 (loopback only). `pnpm demo`.
 * The incident image is a D-Fire test image (CC0) from bench/fixtures/dfire.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env['DEMO_PORT'] ?? 8099);
const files: Record<string, { path: string; type: string }> = {
  '/': { path: join(here, 'index.html'), type: 'text/html; charset=utf-8' },
  '/demo.js': { path: join(here, 'demo.js'), type: 'text/javascript; charset=utf-8' },
  '/assets/AoF07798.jpg': { path: join(here, '..', 'bench', 'fixtures', 'dfire', 'AoF07798.jpg'), type: 'image/jpeg' },
};

createServer((req, res) => {
  const f = files[new URL(req.url ?? '/', 'http://x').pathname];
  if (!f || req.method !== 'GET') {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': f.type, 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'" });
  res.end(readFileSync(f.path));
}).listen(port, '127.0.0.1', () => {
  console.info(`Demo incident page: http://localhost:${port}/  (Ctrl+C to stop)`);
});
