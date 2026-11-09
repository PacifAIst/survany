/** Host classification shared by config validation (§6.2), guardedFetch (SG-14) and the SSRF guard (SG-19). */

export type HostClass = 'loopback' | 'private' | 'link-local' | 'cgnat' | 'unspecified' | 'multicast' | 'public' | 'hostname';

function parseIpv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

/** Expands an IPv6 literal (no brackets) into 8 hextets, or null. Handles embedded IPv4. */
function parseIpv6(host: string): number[] | null {
  let h = host.toLowerCase();
  const zone = h.indexOf('%');
  if (zone >= 0) h = h.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(h) || !h.includes(':')) return null;
  let tail: number[] = [];
  const lastColon = h.lastIndexOf(':');
  const maybeV4 = h.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = parseIpv4(maybeV4);
    if (!v4) return null;
    tail = [((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0)];
    h = h.slice(0, lastColon + 1) + '0:0';
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const toNums = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const p of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
      out.push(parseInt(p, 16));
    }
    return out;
  };
  const head = toNums(halves[0] ?? '');
  const rest = halves.length === 2 ? toNums(halves[1] ?? '') : [];
  if (!head || !rest) return null;
  let full: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    full = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    full = head;
  }
  if (full.length !== 8) return null;
  if (tail.length === 2) {
    full[6] = tail[0] ?? 0;
    full[7] = tail[1] ?? 0;
  }
  return full;
}

function classifyV4(p: number[]): HostClass {
  const [a = 0, b = 0] = p;
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (a === 0) return 'unspecified';
  if (a >= 224) return 'multicast';
  return 'public';
}

/** Classifies a URL hostname (brackets allowed for IPv6). DNS names are 'hostname' except localhost. */
export function classifyHost(rawHost: string): HostClass {
  const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  const v4 = parseIpv4(host);
  if (v4) return classifyV4(v4);
  const v6 = parseIpv6(host);
  if (v6) {
    const [h0 = 0, , , , , h5 = 0, h6 = 0, h7 = 0] = v6;
    const allZeroPrefix = v6.slice(0, 5).every((x) => x === 0);
    if (allZeroPrefix && h5 === 0xffff) return classifyV4([h6 >> 8, h6 & 255, h7 >> 8, h7 & 255]);
    if (v6.slice(0, 7).every((x) => x === 0) && h7 === 1) return 'loopback';
    if (v6.every((x) => x === 0)) return 'unspecified';
    if ((h0 & 0xfe00) === 0xfc00) return 'private';
    if ((h0 & 0xffc0) === 0xfe80) return 'link-local';
    if ((h0 & 0xff00) === 0xff00) return 'multicast';
    return 'public';
  }
  return 'hostname';
}

export function isLoopbackHost(host: string): boolean {
  return classifyHost(host) === 'loopback';
}

/** "Loopback or RFC 1918" (§6.2). DNS names other than localhost never qualify: they could resolve anywhere. */
export function isLocalHost(host: string): boolean {
  const c = classifyHost(host);
  return c === 'loopback' || c === 'private';
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function isLocalUrl(url: string): boolean {
  const h = hostOf(url);
  return h !== null && isLocalHost(h);
}

export function isLoopbackUrl(url: string): boolean {
  const h = hostOf(url);
  return h !== null && isLoopbackHost(h);
}

/** SG-19: any non-public address is blocked for the server-side proxy. */
export function isBlockedForProxy(hostOrIp: string): boolean {
  const c = classifyHost(hostOrIp);
  return c !== 'public' && c !== 'hostname';
}
