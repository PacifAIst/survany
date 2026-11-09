// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Action policy (§7 SG-06), loaded from deploy/gate/policy.yaml.
 * SECURITY-GATE SG-06: lock, unlock and alarm-disarm are denied unless one exact entity is listed; emergency-service tools are refused in code and no policy file can enable them.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

const ArgSpec = z
  .object({
    type: z.enum(['string', 'number', 'boolean']),
    enum: z.array(z.union([z.string(), z.number()])).optional(),
    pattern: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict();

const ToolPolicy = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/),
    card: z.string().min(1).max(200),
    args: z.record(ArgSpec),
    entityArg: z.string().optional(),
    entities: z
      .object({
        allow: z.array(z.string()).default([]),
        deny: z.array(z.string()).default([]),
        allowSensitive: z.array(z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/, 'sensitive entities must be listed exactly, no wildcards')).default([]),
      })
      .strict()
      .default({}),
  })
  .strict();

export const PolicySchema = z
  .object({
    version: z.literal(1),
    pendingTtlSeconds: z.number().int().min(30).max(3600),
    tools: z.array(ToolPolicy),
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;
export type ToolPolicyT = z.infer<typeof ToolPolicy>;

/** Never enabled, whatever the policy file says (§1.2, principle 1). */
const EMERGENCY = /\b(emergency|911|112|999|000|police|ambulance|fire[\s_-]?(dept|department|brigade|service)|rescue|sos|panic[\s_-]?call|dial|call[\s_-]?(number|phone))\b/i;
/** Default-denied per entity: only an exact entity in allowSensitive can pass. */
const SENSITIVE_SERVICE = /(^|\.)(unlock|lock|open|alarm_disarm|disarm)$|alarm_control_panel\.|^lock\./i;
const SENSITIVE_ENTITY = /^(lock|alarm_control_panel)\./;

export function loadPolicy(path: string): Policy {
  return PolicySchema.parse(parse(readFileSync(path, 'utf8')));
}

function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9_.]*')}$`);
  return re.test(value);
}

export type PolicyDecision = { ok: true; tool: ToolPolicyT; args: Record<string, string | number | boolean> } | { ok: false; reason: string };

export function checkProposal(policy: Policy, tool: string, rawArgs: Record<string, unknown>): PolicyDecision {
  // Underscores, dots and dashes are word characters to , so `call_police` would slip past; split them first.
  const blob = `${tool} ${JSON.stringify(rawArgs)}`.replace(/[_.:-]/g, ' ');
  if (EMERGENCY.test(blob)) return { ok: false, reason: 'emergency-service actions can never be enabled' };
  const t = policy.tools.find((x) => x.name === tool);
  if (!t) return { ok: false, reason: `tool ${tool} is not in the policy` };
  const args: Record<string, string | number | boolean> = {};
  for (const k of Object.keys(rawArgs)) if (!(k in t.args)) return { ok: false, reason: `argument ${k} is not allowed` };
  for (const [name, spec] of Object.entries(t.args)) {
    const v = rawArgs[name];
    if (v === undefined) return { ok: false, reason: `missing argument ${name}` };
    if (typeof v !== spec.type) return { ok: false, reason: `argument ${name} must be a ${spec.type}` };
    if (spec.enum && !spec.enum.includes(v as string | number)) return { ok: false, reason: `argument ${name} has a value outside the policy` };
    if (typeof v === 'string' && (v.length > 120 || (spec.pattern && !new RegExp(spec.pattern).test(v)))) return { ok: false, reason: `argument ${name} does not match the policy pattern` };
    if (typeof v === 'number' && ((spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max))) return { ok: false, reason: `argument ${name} out of range` };
    args[name] = v as string | number | boolean;
  }
  const service = typeof args['service'] === 'string' ? (args['service'] as string) : tool;
  const entity = t.entityArg ? args[t.entityArg] : undefined;
  if (typeof entity === 'string') {
    if (t.entities.deny.some((p) => globMatch(p, entity))) return { ok: false, reason: `entity ${entity} is denied by policy` };
    const sensitive = SENSITIVE_ENTITY.test(entity) || SENSITIVE_SERVICE.test(service);
    if (sensitive) {
      if (!t.entities.allowSensitive.includes(entity)) return { ok: false, reason: `lock/unlock/disarm on ${entity} is denied unless that exact entity is listed` };
    } else if (!t.entities.allow.some((p) => globMatch(p, entity))) {
      return { ok: false, reason: `entity ${entity} is not allowed by policy` };
    }
  } else if (SENSITIVE_SERVICE.test(service)) {
    return { ok: false, reason: 'lock/unlock/disarm requires an explicit entity' };
  }
  return { ok: true, tool: t, args };
}
