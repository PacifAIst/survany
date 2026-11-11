// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_RECIPES, importRecipe, RecipeImportError } from '../src';

const fire = BUILTIN_RECIPES.find((r) => r.id === 'fire')!;

describe('built-in recipes (§6.3)', () => {
  it('ships exactly the ten launch recipes, each valid', () => {
    expect(BUILTIN_RECIPES.map((r) => r.id).sort()).toEqual(
      [
        'fire', 'robbery', 'other', 'package-at-door', '3d-print-failure', 'dashboard-turns-red',
        'queue-too-long', 'water-leak', 'door-left-open', 'person-in-restricted-zone',
      ].sort(),
    );
  });

  it('every file in recipes/ is a built-in and named after its id', () => {
    const dir = join(__dirname, '..', 'recipes');
    for (const f of readdirSync(dir)) {
      const r = importRecipe(readFileSync(join(dir, f), 'utf8'));
      expect(f).toBe(`${r.id}.watch.json`);
    }
  });

  it('fire matches the §6.3 example and robbery uses a 4-frame montage', () => {
    expect(fire.gate).toMatchObject({ type: 'detector', model: 'fire-smoke-yolox-tiny', classes: ['fire', 'smoke'], minConfidence: 0.6 });
    expect(BUILTIN_RECIPES.find((r) => r.id === 'robbery')?.confirm.framesPerCheck).toBe(4);
  });
});

describe('SG-18 imported recipes cannot change routing, egress or actions', () => {
  const malicious: [string, Record<string, unknown>][] = [
    ['routing at top level', { routing: { fire: ['attacker'] } }],
    ['egress at top level', { egress: { alertMedia: true, liveView: true } }],
    ['actions at top level', { actions: [{ tool: 'lock.unlock' }] }],
    ['mcp at top level', { mcp: { enabled: true } }],
    ['nested in gate', { gate: { ...fire.gate, webhook: 'https://evil.example' } }],
    ['nested in confirm', { confirm: { ...fire.confirm, autoApprove: true } }],
    ['proto pollution', JSON.parse('{"__proto__": {"admin": true}}') as Record<string, unknown>],
  ];

  it.each(malicious)('rejects %s', (_name, extra) => {
    const r = { ...fire, ...extra };
    expect(() => importRecipe(JSON.stringify(r))).toThrow(RecipeImportError);
  });

  it('rejects unknown keys anywhere (strict schema)', () => {
    expect(() => importRecipe({ ...fire, extra: 1 })).toThrow(RecipeImportError);
    expect(() => importRecipe({ ...fire, gate: { ...fire.gate, color: 'x' } })).toThrow(RecipeImportError);
  });

  it('rejects detector classes the model does not have', () => {
    expect(() => importRecipe({ ...fire, gate: { ...fire.gate, classes: ['gun'] } })).toThrow(/not in model/);
  });

  it('rejects confirm prompts outside the §1.2 product boundaries', () => {
    for (const prompt of ['Identify the person at the door by face.', 'What emotion is the person showing?', 'Who is this man?']) {
      expect(() => importRecipe({ ...fire, confirm: { prompt, framesPerCheck: 1 } })).toThrow(/product boundary/);
    }
  });

  it('rejects non-JSON and oversized input', () => {
    expect(() => importRecipe('{nope')).toThrow(/not valid JSON/);
    expect(() => importRecipe('x'.repeat(20_001))).toThrow(/20 kB/);
  });
});

describe('region outline for the vision model', () => {
  it('outlines a partial region and tells the model what the rectangle is; leaves whole-frame and region-less rules alone', async () => {
    const { builtinRecipe, confirmQuestion, outlineRegion, OUTLINE_NOTE } = await import('../src');
    const zone = builtinRecipe('person-in-restricted-zone')!;
    expect(outlineRegion(zone)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(confirmQuestion(zone)).toBe(`${zone.confirm.prompt} ${OUTLINE_NOTE}`);
    expect(zone.confirm.prompt).toMatch(/outlined/);
    expect(outlineRegion(builtinRecipe('door-left-open')!)).not.toBeNull();
    expect(outlineRegion(builtinRecipe('dashboard-turns-red')!)).toBeNull(); // the whole frame: nothing to point at
    const fire = builtinRecipe('fire')!;
    expect(outlineRegion(fire)).toBeNull();
    expect(confirmQuestion(fire)).toBe(fire.confirm.prompt);
    // The outline is neutral: never described with a color a recipe might check for.
    expect(OUTLINE_NOTE).not.toMatch(/\b(red|green|blue|yellow|orange)\b/i);
  });
});
