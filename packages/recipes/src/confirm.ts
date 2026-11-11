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
