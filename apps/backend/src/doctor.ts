/**
 * Deployment check from inside the compose network (PLAN §8 M5, the inside half of `doctor`).
 * Run in the backend container: `docker compose exec backend node dist/cli.js doctor`.
 *
 *  1-3. This backend's OME admission webhook verifies the signature and denies what it does not know:
 *       an unsigned request and a wrongly signed one are refused (401); a correctly signed request for an
 *       unknown stream is answered allowed:false.
 *  4.   OME itself, with no Caddy in front, refuses a WHIP publish that carries no token (its admission
 *       webhook denies it), so `forward_auth` is not the only thing standing in the way (SG-11).
 *  5.   OME's REST API refuses requests without its AccessToken and accepts them with it (SG-20).
 * The outside half is scripts/doctor.ts.
 */
import { randomBytes } from 'node:crypto';
import { hmacSha1Base64Url } from './security/hmac';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface InsideTargets {
  /** This backend, as seen from inside its own container. */
  self: string;
  /** OME's signaling port on the compose network (never published), e.g. http://ome:3333. */
  omeSignaling: string;
  /** OME's REST API on the compose network, e.g. http://ome:8081. Null skips check 5. */
  omeApi: string | null;
  omeApiToken: string | null;
  admissionSecret: string;
  app: string;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

async function status(fetchFn: FetchFn, url: string, init: RequestInit = {}): Promise<{ status: number; body: string }> {
  try {
    const r = await fetchFn(url, { ...init, signal: AbortSignal.timeout(15_000) });
    return { status: r.status, body: (await r.text()).slice(0, 300) };
  } catch (e) {
    return { status: 0, body: e instanceof Error ? e.message : String(e) };
  }
}

export async function runInsideChecks(t: InsideTargets, fetchFn: FetchFn = fetch): Promise<Check[]> {
  const checks: Check[] = [];
  const unknownToken = randomBytes(32).toString('base64url').slice(0, 43);
  const body = JSON.stringify({
    client: { address: '10.0.0.1', port: 50000 },
    request: { direction: 'incoming', protocol: 'webrtc', status: 'opening', url: `ws://ome:3333/${t.app}/${unknownToken}?direction=whip`, time: new Date().toISOString() },
  });
  const post = (sig: string | null) =>
    status(fetchFn, `${t.self}/ome/admission`, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig ? { 'x-ome-signature': sig } : {}) }, body });

  const unsigned = await post(null);
  checks.push({ name: 'admission webhook refuses an unsigned request', ok: unsigned.status === 401, detail: `HTTP ${unsigned.status}` });
  const forged = await post(hmacSha1Base64Url(`${t.admissionSecret}-wrong`, body));
  checks.push({ name: 'admission webhook refuses a wrong signature', ok: forged.status === 401, detail: `HTTP ${forged.status}` });
  const signed = await post(hmacSha1Base64Url(t.admissionSecret, body));
  let allowed: unknown = undefined;
  try {
    allowed = (JSON.parse(signed.body) as { allowed?: unknown }).allowed;
  } catch {
    // not JSON
  }
  checks.push({ name: 'admission webhook denies a correctly signed request for an unknown stream', ok: signed.status === 200 && allowed === false, detail: `HTTP ${signed.status}, allowed=${String(allowed)}` });

  const whip = await status(fetchFn, `${t.omeSignaling}/${t.app}/doctor-untokened-probe?direction=whip&transport=all`, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: 'v=0\r\n' });
  checks.push({
    name: 'OME itself refuses an untokened WHIP publish (no Caddy in front)',
    ok: whip.status === 401 || whip.status === 403,
    detail: whip.status === 0 ? `no answer from ${t.omeSignaling}: ${whip.body}` : `HTTP ${whip.status}${whip.status === 401 || whip.status === 403 ? '' : ': OME admitted or misrouted a publish without a token'}`,
  });

  if (t.omeApi) {
    const url = `${t.omeApi}/v1/stats/current`;
    const bare = await status(fetchFn, url);
    const withToken = t.omeApiToken ? await status(fetchFn, url, { headers: { authorization: `Basic ${Buffer.from(t.omeApiToken).toString('base64')}` } }) : { status: 0, body: 'OME_API_TOKEN not set' };
    checks.push({ name: 'OME REST API refuses requests without the AccessToken', ok: bare.status === 401 || bare.status === 403, detail: `HTTP ${bare.status}` });
    checks.push({ name: 'OME REST API accepts the AccessToken', ok: withToken.status === 200, detail: `HTTP ${withToken.status}` });
  }
  return checks;
}
