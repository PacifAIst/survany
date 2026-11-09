// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Defensive parse (§6.1, C12). Garbage output is a provider failure, never "none".
 */
import type { DetectionResult } from '@survey-anything/shared';
import { z } from 'zod';
import { ProviderError } from './errors';

const DetectionSchema = z.object({
  event: z.string().min(1).max(64),
  confidence: z.union([z.number(), z.string().regex(/^\s*-?\d+(\.\d+)?\s*$/).transform(Number)]),
  reason: z.string().max(4000).default(''),
});

/** Returns the first balanced top-level JSON object in `text`, ignoring braces inside strings. */
export function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function stripCodeFences(text: string): string {
  return text.replace(/```(?:json|JSON)?\s*([\s\S]*?)```/g, '$1');
}

export function parseDetection(raw: unknown, allowedEvents: readonly string[], providerId: string | null = null): DetectionResult {
  if (typeof raw !== 'string' || raw.trim() === '') throw new ProviderError('parse', 'empty model output', null, providerId);
  const candidate = firstJsonObject(stripCodeFences(raw));
  if (!candidate) throw new ProviderError('parse', 'no JSON object in model output', null, providerId);
  let obj: unknown;
  try {
    obj = JSON.parse(candidate);
  } catch {
    throw new ProviderError('parse', 'malformed JSON in model output', null, providerId);
  }
  const r = DetectionSchema.safeParse(obj);
  if (!r.success) throw new ProviderError('parse', 'model output does not match {event, confidence, reason}', null, providerId);
  const event = r.data.event.trim();
  const allowed = new Set([...allowedEvents, 'none']);
  if (!allowed.has(event)) throw new ProviderError('parse', `model returned unknown event '${event.slice(0, 40)}'`, null, providerId);
  const c = Number(r.data.confidence);
  if (!Number.isFinite(c)) throw new ProviderError('parse', 'confidence is not a number', null, providerId);
  // Some models answer in percent ("85"). Values just over 1 ("1.2") are over-range decimals and get clamped.
  const normalized = c >= 2 && c <= 100 ? c / 100 : c;
  return { event, confidence: Math.min(1, Math.max(0, normalized)), reason: r.data.reason };
}

export function parseProbeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const json = firstJsonObject(stripCodeFences(raw));
  if (json) {
    try {
      const o = JSON.parse(json) as { code?: unknown };
      if (typeof o.code === 'string') return o.code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    } catch {
      // fall through to plain-text read
    }
  }
  const m = /\b([A-Z0-9]{4,10})\b/.exec(raw.toUpperCase());
  return m?.[1] ?? null;
}
