// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Draws a rule's region on the confirm image (packages/recipes/src/confirm.ts explains why): a solid black
 * rectangle with white dashes on top, so it stays visible on light and dark scenes and carries no color a
 * recipe might be looking for. Only the image sent to the model and the snapshot get it; the on-device
 * gate always runs on the raw frame.
 */
import type { Region } from '@survey-anything/recipes';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  lineWidth: number;
}

/** The rectangle for `region` inside a cell of the image at (x0, y0) with size cw x ch, in pixels. */
export function outlineRect(region: Region, x0: number, y0: number, cw: number, ch: number): Rect {
  const lineWidth = Math.max(2, Math.round(Math.min(cw, ch) / 120));
  const half = lineWidth / 2;
  // Keep the stroke inside the cell so a region touching the edge stays fully visible.
  const x = Math.min(Math.max(x0 + region.x * cw, x0 + half), x0 + cw - half);
  const y = Math.min(Math.max(y0 + region.y * ch, y0 + half), y0 + ch - half);
  const right = Math.min(x0 + (region.x + region.w) * cw, x0 + cw - half);
  const bottom = Math.min(y0 + (region.y + region.h) * ch, y0 + ch - half);
  return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y), lineWidth };
}

export function drawOutline(ctx: OffscreenCanvasRenderingContext2D, r: Rect): void {
  ctx.save();
  ctx.lineWidth = r.lineWidth;
  ctx.setLineDash([]);
  ctx.strokeStyle = '#000';
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.setLineDash([r.lineWidth * 3, r.lineWidth * 3]);
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}
