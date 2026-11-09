#!/usr/bin/env node
/**
 * Deployment check from outside the server (PLAN §8 M5): run it from your laptop or phone hotspot after
 * `docker compose --profile ome up -d`.
 *
 *   pnpm doctor --public alerts.example.org --live live.example.org [--ip 203.0.113.7]
 *
 * Checks: the backend answers through TLS; OME signaling answers through TLS; 3478/tcp (OME TcpRelay)
 * and 10000/tcp (ICE-TCP) accept connections; an untokened WHIP publish is refused. Exit code 1 if any
 * check fails. It never sends media. The inside-the-network checks (admission webhook signature, OME
 * refusing an untokened publish without Caddy in front) are covered by the M5 Docker test suite.
 */
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export function parseArgs(argv: string[]): { pub: string; live: string; ip: string | null } {
  const get = (k: string): string | null => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const pub = get('public');
  const live = get('live');
  if (!pub || !live) throw new Error('usage: pnpm doctor --public <PUBLIC_HOST> --live <LIVE_HOST> [--ip <OME_HOST_IP>]');
  return { pub, live, ip: get('ip') };
}

export function tcpOpen(host: string, port: number, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port, timeout: timeoutMs }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.on('timeout', () => {
      s.destroy();
      resolve(false);
    });
  });
}

/** A WHIP publish with no token must be refused: by forward_auth (403) or OME admission (401). */
export function untokenedVerdict(status: number): Check {
  if (status === 401 || status === 403) return { name: 'untokened WHIP publish refused', ok: true, detail: `HTTP ${status}` };
  if (status === 0) return { name: 'untokened WHIP publish refused', ok: false, detail: 'no answer from the signaling endpoint (cannot tell)' };
  return { name: 'untokened WHIP publish refused', ok: false, detail: `HTTP ${status}: a publish without a token was not refused (SG-11)` };
}

export async function runDoctor(pub: string, live: string, ip: string | null, fetchFn: typeof fetch = fetch): Promise<Check[]> {
  const checks: Check[] = [];
  const get = async (url: string, init: RequestInit = {}): Promise<number> => {
    try {
      return (await fetchFn(url, { ...init, signal: AbortSignal.timeout(8000), redirect: 'manual' })).status;
    } catch {
      return 0;
    }
  };
  const health = await get(`https://${pub}/healthz`);
  checks.push({ name: 'backend reachable over TLS', ok: health === 200, detail: health ? `https://${pub}/healthz -> HTTP ${health}` : 'no answer' });
  const sig = await get(`https://${live}/`);
  checks.push({ name: 'OME signaling reachable over TLS', ok: sig > 0 && sig < 500, detail: sig ? `https://${live}/ -> HTTP ${sig}` : 'no answer' });
  const mediaHost = ip ?? live;
  for (const [port, what] of [
    [3478, 'OME TcpRelay (UDP-blocked viewers)'],
    [10000, 'ICE-TCP media'],
  ] as const) {
    const open = await tcpOpen(mediaHost, port);
    checks.push({ name: `${port}/tcp open: ${what}`, ok: open, detail: `${mediaHost}:${port} ${open ? 'accepts connections' : 'closed or filtered'}` });
  }
  const whip = await get(`https://${live}/app/doctor-untokened-probe?direction=whip&transport=all`, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: 'v=0\r\n' });
  checks.push(untokenedVerdict(whip));
  return checks;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  (async () => {
    const { pub, live, ip } = parseArgs(process.argv.slice(2));
    const checks = await runDoctor(pub, live, ip);
    for (const c of checks) console.info(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
    console.info('UDP 10000-10003 cannot be tested from here without a WebRTC session; the extension checks it at arm time and warns if live view will need the TCP relay.');
    if (checks.some((c) => !c.ok)) process.exit(1);
  })().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  });
}
