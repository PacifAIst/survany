// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SECURITY-GATE SG-19: proxy mode only reaches allowlisted provider hosts over https, and refuses any host that resolves to a private, loopback, link-local or otherwise non-public address.
 */
import { lookup } from 'node:dns/promises';
import { isBlockedForProxy } from '@survey-anything/shared';

export class SsrfError extends Error {}

export type Resolver = (host: string) => Promise<string[]>;

export const systemResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export async function assertProxyTarget(url: string, allowedHosts: readonly string[], resolve: Resolver = systemResolver): Promise<URL> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new SsrfError('invalid URL');
  }
  if (u.protocol !== 'https:') throw new SsrfError('proxy targets must use https');
  if (u.username || u.password) throw new SsrfError('credentials in URL are not allowed');
  if (u.port && u.port !== '443') throw new SsrfError('non-standard ports are not allowed');
  const host = u.hostname.toLowerCase();
  if (!allowedHosts.map((h) => h.toLowerCase()).includes(host)) throw new SsrfError(`host ${host} is not on the provider allowlist`);
  if (isBlockedForProxy(host)) throw new SsrfError('IP literal in a non-public range');
  const addrs = await resolve(host);
  if (addrs.length === 0) throw new SsrfError('host did not resolve');
  for (const a of addrs) if (isBlockedForProxy(a)) throw new SsrfError(`host resolves to a non-public address (${a})`);
  return u;
}

/** fetch that re-checks the target on every call and never follows redirects. */
export function ssrfSafeFetch(allowedHosts: readonly string[], resolve: Resolver = systemResolver) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    await assertProxyTarget(url, allowedHosts, resolve);
    return fetch(url, { ...init, redirect: 'error' });
  };
}
