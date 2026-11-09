// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Watch recipe schema (§6.3). Recipes are data only.
 * SECURITY-GATE SG-18: strict schema plus a deep forbidden-key scan, so an imported recipe cannot change routing, egress or actions.
 */
import { z } from 'zod';
import { DETECTOR_MODELS } from './models';

export const RegionSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0.01).max(1),
    h: z.number().min(0.01).max(1),
  })
  .strict()
  .refine((r) => r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001, 'region must lie inside the frame');
export type Region = z.infer<typeof RegionSchema>;

const DetectorGate = z
  .object({
    type: z.literal('detector'),
    model: z.enum(Object.keys(DETECTOR_MODELS) as [string, ...string[]]),
    classes: z.array(z.string().min(1).max(40)).min(1).max(20),
    requireClasses: z.array(z.string().min(1).max(40)).max(5).optional(),
    minCount: z.number().int().min(1).max(100).optional(),
    requireMotion: z.boolean().optional(),
    minConfidence: z.number().min(0.05).max(0.99),
    region: RegionSchema.optional(),
  })
  .strict();

const MotionGate = z
  .object({
    type: z.literal('motion'),
    pixelDelta: z.number().int().min(4).max(255).default(25),
    threshold: z.number().min(0.001).max(0.9),
    region: RegionSchema.optional(),
  })
  .strict();

const RegionDiffGate = z
  .object({
    type: z.literal('region-diff'),
    region: RegionSchema,
    mode: z.enum(['any-change', 'color-shift']),
    targetColor: z.enum(['red', 'green', 'blue', 'yellow', 'orange']).optional(),
    threshold: z.number().min(0.001).max(0.9),
  })
  .strict()
  .refine((g) => g.mode !== 'color-shift' || g.targetColor !== undefined, 'color-shift needs targetColor');

const SampledGate = z
  .object({ type: z.literal('sampled'), everyMinutes: z.number().int().min(1).max(1440) })
  .strict();

export const GateSchema = z.union([DetectorGate, MotionGate, RegionDiffGate, SampledGate]);
export type Gate = z.infer<typeof GateSchema>;

/** §1.2 product boundaries: confirm prompts ask about scenes, never identities or emotions. */
const OUT_OF_SCOPE_PROMPT =
  /\b(face|facial|faces|identify\s+(the\s+)?(person|people|who|individual)|who\s+is\s+(this|that|the)|recogni[sz]e\s+(the\s+)?(person|people|face)|re-?identif|emotion|emotional|mood|feeling|biometric|ethnicity|race|gender|age\s+of)\b/i;

export const RecipeSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
    title: z.string().min(1).max(80),
    description: z.string().max(300).optional(),
    gate: GateSchema,
    confirm: z
      .object({
        prompt: z
          .string()
          .min(10)
          .max(600)
          .refine((p) => !OUT_OF_SCOPE_PROMPT.test(p), 'confirm prompt touches a permanent product boundary (§1.2)'),
        framesPerCheck: z.number().int().min(1).max(4),
      })
      .strict(),
    severity: z.enum(['info', 'warning', 'critical']),
    author: z.string().max(60).optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.gate.type === 'detector') {
      const model = DETECTOR_MODELS[r.gate.model];
      const known = new Set(model?.classes ?? []);
      for (const c of [...r.gate.classes, ...(r.gate.requireClasses ?? [])]) {
        if (!known.has(c)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['gate', 'classes'], message: `class '${c}' is not in model ${r.gate.model}` });
      }
    }
  });
export type Recipe = z.infer<typeof RecipeSchema>;

/** Keys that belong to user config, never to a shared recipe. */
export const FORBIDDEN_RECIPE_KEYS = [
  'routing', 'recipients', 'contacts', 'egress', 'alertMedia', 'liveView', 'actions', 'action', 'mcp', 'tools',
  'tool', 'approve', 'approval', 'autoApprove', 'webhook', 'url', 'endpoint', 'channels', 'provider',
  'providerProfiles', 'failoverChain', 'allowCloudProviders', 'proxyMode', 'budget', 'stream', 'backend', 'direct',
  '__proto__', 'constructor', 'prototype',
];

export function findForbiddenKeys(value: unknown, path = ''): string[] {
  if (!value || typeof value !== 'object') return [];
  const hits: string[] = [];
  for (const key of Object.keys(value)) {
    const p = path ? `${path}.${key}` : key;
    if (FORBIDDEN_RECIPE_KEYS.some((f) => f.toLowerCase() === key.toLowerCase())) hits.push(p);
    hits.push(...findForbiddenKeys((value as Record<string, unknown>)[key], p));
  }
  return hits;
}
