// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Config schema v1 (PLAN §6.2). Keys from the original spec are unchanged; the
 * optional `backend`, `direct` and `alerts.nonRedundantAck` keys are additions
 * (logged in PROGRESS.md) and default so the §6.2 sample validates verbatim.
 */
import { z } from 'zod';
import {
  PROVIDER_IDS,
  PROVIDER_TIMEOUT_DEFAULT_MS,
  PROVIDER_TIMEOUT_MAX_MS,
  SCAN_FLOOR_CLOUD_MS,
  SCAN_FLOOR_LOCAL_MS,
  STREAM_TTL_MAX_MINUTES,
} from './defaults';
import { isLocalUrl, isLoopbackUrl } from './net';

export const ProviderIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ChannelSchema = z.enum(['telegram', 'email']);
export type Channel = z.infer<typeof ChannelSchema>;

export const ContactIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/, 'contact id: letters, digits, _ or -, max 32');
export const RuleIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'rule id: lowercase slug, max 48');
const KeyRefSchema = z.string().regex(/^key_[a-z0-9_]{1,40}$/, 'apiKeyRef must look like key_<name>');

const HttpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//.test(u), 'must be an http(s) URL');

export const ProviderProfileSchema = z
  .object({
    baseUrl: HttpUrl,
    model: z.string().min(1).max(200).nullable(),
    apiKeyRef: KeyRefSchema.nullable(),
    timeoutMs: z.number().int().min(1000).max(PROVIDER_TIMEOUT_MAX_MS).default(PROVIDER_TIMEOUT_DEFAULT_MS),
  })
  .strict();
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

const PrimaryProviderSchema = ProviderProfileSchema.extend({ id: ProviderIdSchema }).strict();
/** A provider profile with its id, as Test Connection sends it. */
export const ResolvedProfileSchema = PrimaryProviderSchema;

const RoleSchema = z.enum(['viewer', 'approver']);

const DirectTelegramSchema = z
  .object({
    botTokenRef: KeyRefSchema,
    chatIds: z.record(ContactIdSchema, z.string().regex(/^-?\d{1,20}$/)),
  })
  .strict();

const DirectEmailSchema = z
  .object({
    provider: z.literal('resend'),
    apiKeyRef: KeyRefSchema,
    from: z.string().email(),
    addresses: z.record(ContactIdSchema, z.string().email()),
  })
  .strict();

export const ConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: PrimaryProviderSchema,
    providerProfiles: z.record(ProviderIdSchema, ProviderProfileSchema).default({}),
    reasoner: z
      .object({
        enabled: z.boolean(),
        providerId: ProviderIdSchema.nullable(),
        model: z.string().min(1).max(200).nullable(),
      })
      .strict()
      .default({ enabled: false, providerId: null, model: null }),
    failoverChain: z.array(ProviderIdSchema).max(5),
    allowCloudProviders: z.boolean(),
    proxyMode: z.boolean(),
    egress: z.object({ alertMedia: z.boolean(), liveView: z.boolean() }).strict(),
    vision: z
      .object({
        enableVision: z.boolean(),
        scanIntervalMs: z.number().int().min(SCAN_FLOOR_LOCAL_MS).max(600_000),
        minYoloConfidence: z.number().min(0.05).max(0.99),
        cooldownPerEventMs: z.number().int().min(0).max(86_400_000),
        risingEdgeOnly: z.boolean(),
        downscaleMaxPx: z.number().int().min(256).max(2048),
        jpegQuality: z.number().min(0.3).max(0.95),
        maxOutputTokens: z.number().int().min(50).max(2000),
      })
      .strict(),
    gate: z
      .object({ minHits: z.number().int().min(1).max(30), windowFrames: z.number().int().min(1).max(30) })
      .strict()
      .refine((g) => g.minHits <= g.windowFrames, 'gate.minHits must be <= gate.windowFrames'),
    budget: z
      .object({
        maxCallsPerMinute: z.number().int().min(1).max(600),
        dailyMaxApiCalls: z.number().int().min(1).max(1_000_000),
        dailyTokenCap: z.number().int().min(1000).max(1_000_000_000),
        hardStopOnBudget: z.literal(true),
      })
      .strict(),
    stream: z
      .object({
        ttlMinutes: z.number().int().min(1).max(STREAM_TTL_MAX_MINUTES),
        singleUse: z.literal(true),
        viewerAllowlistOnly: z.literal(true),
      })
      .strict(),
    clip: z
      .object({
        seconds: z.number().int().min(5).max(30),
        videoBitsPerSecond: z.number().int().min(100_000).max(4_000_000),
      })
      .strict(),
    alerts: z
      .object({
        channels: z.array(ChannelSchema).min(1).max(2),
        nonRedundantAck: z.boolean().default(false),
        email: z
          .object({ transport: z.enum(['smtp-backend', 'http-direct']), includeSnapshot: z.boolean() })
          .strict(),
        ackTimeoutSec: z.number().int().min(30).max(86_400),
      })
      .strict(),
    contacts: z.record(ContactIdSchema, z.object({ roles: z.array(RoleSchema).min(1) }).strict()),
    routing: z.record(RuleIdSchema, z.array(ContactIdSchema).min(1)),
    rules: z.array(RuleIdSchema).min(1),
    mcp: z
      .object({
        enabled: z.boolean(),
        requireSecondChannelApproval: z.literal(true),
        approvalTimeoutSec: z.number().int().min(30).max(3600),
      })
      .strict(),
    backend: z.object({ url: HttpUrl.nullable() }).strict().default({ url: null }),
    direct: z
      // Each direct channel defaults to off, so turning on one does not require mentioning the other.
      .object({ telegram: DirectTelegramSchema.nullable().default(null), email: DirectEmailSchema.nullable().default(null) })
      .strict()
      .default({ telegram: null, email: null }),
  })
  .strict()
  .superRefine((c, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    };

    // Channels: unique; single channel needs the one-time acknowledgement.
    if (new Set(c.alerts.channels).size !== c.alerts.channels.length) issue(['alerts', 'channels'], 'channels must be unique');
    if (c.alerts.channels.length === 1 && !c.alerts.nonRedundantAck) {
      issue(['alerts', 'nonRedundantAck'], 'a single alert channel requires acknowledging that alerts will not be redundant');
    }
    // SG-04 / D5: approvals exist only on Telegram.
    if (c.mcp.enabled && !c.alerts.channels.includes('telegram')) {
      issue(['mcp', 'enabled'], 'mcp.enabled requires telegram in alerts.channels (approvals exist only on Telegram)');
    }

    // Chain resolution.
    const resolved = c.failoverChain.map((id) => resolveProfile(c, id));
    c.failoverChain.forEach((id, i) => {
      const p = resolved[i];
      if (!p) issue(['failoverChain', i], `provider '${id}' has no profile`);
      else if (!p.model) issue(['failoverChain', i], `provider '${id}' has no model selected`);
    });
    if (new Set(c.failoverChain).size !== c.failoverChain.length) issue(['failoverChain'], 'chain entries must be unique');
    if (c.vision.enableVision && c.failoverChain.length === 0) {
      issue(['failoverChain'], 'enableVision requires at least one provider in the chain');
    }

    // allowCloudProviders:false -> loopback or RFC 1918 only; proxyMode only to a loopback backend.
    if (!c.allowCloudProviders) {
      resolved.forEach((p, i) => {
        if (p && !isLocalUrl(p.baseUrl)) issue(['failoverChain', i], 'allowCloudProviders:false requires a loopback or RFC 1918 host');
      });
      if (c.reasoner.enabled && c.reasoner.providerId) {
        const r = resolveProfile(c, c.reasoner.providerId);
        if (r && !isLocalUrl(r.baseUrl)) issue(['reasoner'], 'allowCloudProviders:false requires a local reasoner');
      }
      if (c.proxyMode && !(c.backend.url && isLoopbackUrl(c.backend.url))) {
        issue(['proxyMode'], 'with allowCloudProviders:false, proxyMode is allowed only to a loopback backend');
      }
    }
    if (c.proxyMode && !c.backend.url) issue(['proxyMode'], 'proxyMode requires backend.url');

    // Scan interval floor: 2 s with any cloud provider in the chain, 500 ms if fully local.
    const anyCloud = resolved.some((p) => p && !isLocalUrl(p.baseUrl));
    const floor = anyCloud && c.vision.enableVision ? SCAN_FLOOR_CLOUD_MS : SCAN_FLOOR_LOCAL_MS;
    if (c.vision.scanIntervalMs < floor) issue(['vision', 'scanIntervalMs'], `scan interval floor is ${floor} ms for this chain`);

    // Routing and contacts.
    if (!c.contacts['owner']) issue(['contacts', 'owner'], "an 'owner' contact is required (ack escalation, dead-man alerts)");
    if (c.mcp.enabled && !Object.values(c.contacts).some((x) => x.roles.includes('approver'))) {
      issue(['contacts'], 'mcp.enabled requires at least one contact with the approver role');
    }
    for (const [rule, recipients] of Object.entries(c.routing)) {
      if (!c.rules.includes(rule)) issue(['routing', rule], `routing names unknown rule '${rule}'`);
      recipients.forEach((r, i) => {
        if (!c.contacts[r]) issue(['routing', rule, i], `routing names unknown contact '${r}'`);
      });
    }
    if (new Set(c.rules).size !== c.rules.length) issue(['rules'], 'rules must be unique');

    // Direct (T0) channels must name known contacts.
    for (const [kind, map] of [
      ['telegram', c.direct.telegram?.chatIds],
      ['email', c.direct.email?.addresses],
    ] as const) {
      for (const contact of Object.keys(map ?? {})) {
        if (!c.contacts[contact]) issue(['direct', kind], `direct ${kind} names unknown contact '${contact}'`);
      }
    }
    if (c.alerts.email.transport === 'http-direct' && c.alerts.channels.includes('email') && !c.direct.email && !c.backend.url) {
      issue(['alerts', 'email', 'transport'], 'http-direct email needs direct.email configured');
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;

export interface ResolvedProfile extends ProviderProfile {
  id: ProviderId;
}

export function resolveProfile(
  c: Pick<Config, 'provider' | 'providerProfiles'>,
  id: ProviderId,
): ResolvedProfile | null {
  if (c.provider.id === id) return { ...c.provider };
  const p = c.providerProfiles[id];
  return p ? { ...p, id } : null;
}

export function resolveChain(c: Config): ResolvedProfile[] {
  return c.failoverChain.map((id) => resolveProfile(c, id)).filter((p): p is ResolvedProfile => p !== null);
}

export function isCloudProfile(p: Pick<ProviderProfile, 'baseUrl'>): boolean {
  return !isLocalUrl(p.baseUrl);
}

export type ConfigParse = { ok: true; config: Config } | { ok: false; errors: string[] };

export function parseConfig(input: unknown): ConfigParse {
  const r = ConfigSchema.safeParse(input);
  if (r.success) return { ok: true, config: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}

/** Recipients for a rule, falling back to `other`, then `owner`. */
export function recipientsFor(c: Config, rule: string): string[] {
  return c.routing[rule] ?? c.routing['other'] ?? ['owner'];
}
