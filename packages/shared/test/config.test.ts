// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { defaultConfigInput, EXAMPLE_CONFIG_JSON, parseConfig, recipientsFor, resolveChain } from '../src';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
type Mutable = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function withPatch(patch: (c: Mutable) => void): ReturnType<typeof parseConfig> {
  const c = clone(EXAMPLE_CONFIG_JSON) as Mutable;
  patch(c);
  return parseConfig(c);
}

describe('config schema v1 (§6.2)', () => {
  it('accepts the §6.2 sample verbatim', () => {
    const r = parseConfig(clone(EXAMPLE_CONFIG_JSON));
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it('accepts the fresh-install default', () => {
    const r = parseConfig(defaultConfigInput());
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it('T0: one direct channel can be on without mentioning the other (README quickstart)', () => {
    const r = withPatch((c) => {
      c['direct'] = { telegram: { botTokenRef: 'key_telegram_bot', chatIds: { owner: '123456789' } } };
      c['alerts'] = { ...c['alerts'], channels: ['telegram'], nonRedundantAck: true };
    });
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (r.ok) expect(r.config.direct.email).toBeNull();
  });

  it('resolves the chain in order, primary provider included', () => {
    const r = parseConfig(clone(EXAMPLE_CONFIG_JSON));
    if (!r.ok) throw new Error(r.errors.join());
    expect(resolveChain(r.config).map((p) => p.id)).toEqual(['local', 'openrouter', 'anthropic']);
    expect(resolveChain(r.config)[1]?.model).toBe('qwen/qwen2.5-vl-72b-instruct');
  });

  it.each([
    ['stream.singleUse', (c: Mutable) => (c.stream.singleUse = false)],
    ['stream.viewerAllowlistOnly', (c: Mutable) => (c.stream.viewerAllowlistOnly = false)],
    ['budget.hardStopOnBudget', (c: Mutable) => (c.budget.hardStopOnBudget = false)],
    ['mcp.requireSecondChannelApproval', (c: Mutable) => (c.mcp.requireSecondChannelApproval = false)],
  ])('%s is literal true, displayed but not editable', (_name, patch) => {
    expect(withPatch(patch).ok).toBe(false);
  });

  it('caps stream TTL at 10 minutes', () => {
    expect(withPatch((c) => (c.stream.ttlMinutes = 11)).ok).toBe(false);
    expect(withPatch((c) => (c.stream.ttlMinutes = 10)).ok).toBe(true);
  });

  it('allowCloudProviders:false requires loopback or RFC 1918 hosts', () => {
    const bad = withPatch((c) => (c.allowCloudProviders = false));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join('\n')).toMatch(/loopback or RFC 1918/);
    const good = withPatch((c) => {
      c.allowCloudProviders = false;
      c.failoverChain = ['local'];
      c.provider = { id: 'local', baseUrl: 'http://192.168.1.20:11434/v1', model: 'qwen2.5vl', apiKeyRef: null };
    });
    expect(good.ok ? [] : good.errors).toEqual([]);
    const hostname = withPatch((c) => {
      c.allowCloudProviders = false;
      c.failoverChain = ['local'];
      c.provider = { id: 'local', baseUrl: 'http://ollama.lan:11434/v1', model: 'qwen2.5vl', apiKeyRef: null };
    });
    expect(hostname.ok).toBe(false);
  });

  it('allowCloudProviders:false allows proxyMode only to a loopback backend', () => {
    const base = (c: Mutable): void => {
      c.allowCloudProviders = false;
      c.failoverChain = ['local'];
      c.provider = { id: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5vl', apiKeyRef: null };
      c.proxyMode = true;
    };
    expect(withPatch((c) => { base(c); c.backend = { url: 'https://alerts.example.org' }; }).ok).toBe(false);
    expect(withPatch((c) => { base(c); c.backend = { url: 'http://127.0.0.1:8080' }; }).ok).toBe(true);
  });

  it('enforces the scan interval floor: 2 s with cloud, 500 ms fully local', () => {
    expect(withPatch((c) => (c.vision.scanIntervalMs = 1999)).ok).toBe(false);
    const local = (ms: number) =>
      withPatch((c) => {
        c.failoverChain = ['local'];
        c.provider = { id: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5vl', apiKeyRef: null };
        c.vision.scanIntervalMs = ms;
      });
    expect(local(500).ok).toBe(true);
    expect(local(499).ok).toBe(false);
  });

  it('alerts.channels: min 1, max 2, unique, single channel needs acknowledgement', () => {
    expect(withPatch((c) => (c.alerts.channels = [])).ok).toBe(false);
    expect(withPatch((c) => (c.alerts.channels = ['telegram', 'telegram'])).ok).toBe(false);
    expect(withPatch((c) => (c.alerts.channels = ['telegram', 'email', 'sms'])).ok).toBe(false);
    const single = withPatch((c) => (c.alerts.channels = ['email']));
    expect(single.ok).toBe(false);
    if (!single.ok) expect(single.errors.join()).toMatch(/not be redundant/);
    expect(withPatch((c) => { c.alerts.channels = ['email']; c.alerts.nonRedundantAck = true; }).ok).toBe(true);
    expect(withPatch((c) => { c.alerts.channels = ['telegram']; c.alerts.nonRedundantAck = true; }).ok).toBe(true);
  });

  it('mcp.enabled requires telegram (approvals exist only on Telegram)', () => {
    const r = withPatch((c) => {
      c.mcp.enabled = true;
      c.alerts.channels = ['email'];
      c.alerts.nonRedundantAck = true;
    });
    expect(r.ok).toBe(false);
    expect(withPatch((c) => (c.mcp.enabled = true)).ok).toBe(true);
  });

  it('routing must reference known rules and contacts, and owner must exist', () => {
    expect(withPatch((c) => (c.routing.fire = ['nobody'])).ok).toBe(false);
    expect(withPatch((c) => (c.routing.flood = ['owner'])).ok).toBe(false);
    expect(withPatch((c) => delete c.contacts.owner).ok).toBe(false);
  });

  it('rejects unknown keys (strict), e.g. a group-alerting flag (D12)', () => {
    expect(withPatch((c) => (c.alerts.groupChats = true)).ok).toBe(false);
    expect(withPatch((c) => (c.stealthMode = true)).ok).toBe(false);
  });

  it('falls back to other, then owner, for unrouted rules', () => {
    const r = parseConfig(clone(EXAMPLE_CONFIG_JSON));
    if (!r.ok) throw new Error();
    expect(recipientsFor(r.config, 'robbery')).toEqual(['contactB', 'contactC']);
    expect(recipientsFor(r.config, 'water-leak')).toEqual(['owner']);
  });
});
