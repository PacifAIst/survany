// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the vision model is shown for a rule with a region. The on-device gate only looks inside the
 * region, but the model gets the whole frame, so without help it cannot know which part matters. The
 * worker outlines the region on the confirm image with a black-and-white dashed rectangle (neutral
 * against any color a recipe checks for), and the question says what the rectangle is.
 */
import type { Recipe, Region } from './schema';

export const OUTLINE_NOTE =
  'The area to check is marked with a black-and-white dashed rectangle. The rectangle was drawn by the monitoring tool and is not part of the scene. Answer only about what is inside it.';

/** The region to outline, or null when the rule has none or it covers (almost) the whole frame. */
export function outlineRegion(r: Pick<Recipe, 'gate'>): Region | null {
  const g = r.gate;
  const region = 'region' in g ? g.region : undefined;
  if (!region) return null;
  const coversFrame = region.x <= 0.02 && region.y <= 0.02 && region.x + region.w >= 0.98 && region.y + region.h >= 0.98;
  return coversFrame ? null : region;
}

/** The question sent to the vision model for a candidate of this rule. */
export function confirmQuestion(r: Pick<Recipe, 'gate' | 'confirm'>): string {
  return outlineRegion(r) ? `${r.confirm.prompt} ${OUTLINE_NOTE}` : r.confirm.prompt;
}

/**
 * Absence rules ("someone left") ask the model the positive question, "is a person visible?", and alert
 * when the answer is no. Asked "is the area empty, with no person?", qwen3-vl-4b-instruct answered "none"
 * (meaning no alert) for an empty scene 16 times in 16, its own reason saying no person was visible; the
 * positive question was answered right 18 times in 18 (2026-11-11). The value the model may answer with
 * is therefore "visible", never the rule id.
 */
export const STILL_VISIBLE_EVENT = 'visible';

export function isAbsenceRule(r: Pick<Recipe, 'gate'>): boolean {
  return r.gate.type === 'detector' && r.gate.absent === true;
}

/** The values the model may answer with for this rule (besides "none"). */
export function confirmEvents(r: Pick<Recipe, 'id' | 'gate'>): string[] {
  return isAbsenceRule(r) ? [STILL_VISIBLE_EVENT] : [r.id];
}

/**
 * Whether the model's answer confirms the rule. A presence rule needs its event at or above the model's
 * threshold. An absence rule is confirmed when the model does not see the classes: the on-device gate
 * already saw nobody, and the model can only veto that by answering "visible".
 */
export function confirmDecision(r: Pick<Recipe, 'id' | 'gate'>, answer: { event: string; confidence: number }, threshold: number): { alert: boolean; confidence: number } {
  if (isAbsenceRule(r)) return answer.event === STILL_VISIBLE_EVENT ? { alert: false, confidence: answer.confidence } : { alert: true, confidence: answer.confidence };
  return { alert: answer.event === r.id && answer.confidence >= threshold, confidence: answer.confidence };
}
