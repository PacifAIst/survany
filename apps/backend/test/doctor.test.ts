// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * M5: the inside half of `doctor` (`node dist/cli.js doctor`) against the real backend app on a port,
 * with a stand-in OME. The real-OME run is in apps/extension/e2e/ome/m5.spec.ts.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { runInsideChecks } from '../src/doctor';
import { makeApp, OME_SECRET } from './helpers';

let ome: Server | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (ome ? ome.close(() => r()) : r()));
  ome = null;
});

/** A stand-in OME: `whipStatus` for any WHIP POST, Basic-token check on the REST API. */
async function fakeOme(whipStatus: number): Promise<string> {
  ome = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'POST' && (req.url ?? '').includes('direction=whip')) {
        res.statusCode = whipStatus;
      } else if ((req.url ?? '').startsWith('/v1/')) {
        res.statusCode = req.headers.authorization === `Basic ${Buffer.from('api_token_test_not_real').toString('base64')}` ? 200 : 401;
      } else res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => ome!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(ome!.address() as AddressInfo).port}`;
}

async function backendOnPort() {
  const t = await makeApp();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  return { t, self: `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}` };
}

describe('doctor, inside the compose network', () => {
  it('passes when the webhook verifies signatures and OME refuses untokened publishes', async () => {
    const { t, self } = await backendOnPort();
    const omeUrl = await fakeOme(401);
    const checks = await runInsideChecks({ self, omeSignaling: omeUrl, omeApi: omeUrl, omeApiToken: 'api_token_test_not_real', admissionSecret: OME_SECRET, app: 'app' });
    await t.app.close();
    expect(checks.map((c) => [c.name, c.ok])).toEqual([
      ['admission webhook refuses an unsigned request', true],
      ['admission webhook refuses a wrong signature', true],
      ['admission webhook denies a correctly signed request for an unknown stream', true],
      ['OME itself refuses an untokened WHIP publish (no Caddy in front)', true],
      ['OME REST API refuses requests without the AccessToken', true],
      ['OME REST API accepts the AccessToken', true],
    ]);
  });

  it('fails when OME admits an untokened publish or the secret is wrong', async () => {
    const { t, self } = await backendOnPort();
    const omeUrl = await fakeOme(201);
    const admitted = await runInsideChecks({ self, omeSignaling: omeUrl, omeApi: null, omeApiToken: null, admissionSecret: OME_SECRET, app: 'app' });
    expect(admitted.find((c) => c.name.startsWith('OME itself'))).toMatchObject({ ok: false });
    // Doctor run with a different secret than the backend's: the "correctly signed" request is refused, which is reported.
    const wrongSecret = await runInsideChecks({ self, omeSignaling: omeUrl, omeApi: null, omeApiToken: null, admissionSecret: 'not_the_backend_secret', app: 'app' });
    await t.app.close();
    expect(wrongSecret.find((c) => c.name.includes('correctly signed'))).toMatchObject({ ok: false, detail: expect.stringContaining('HTTP 401') });
  });
});
