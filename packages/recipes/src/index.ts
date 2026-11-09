// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
import doorLeftOpen from '../recipes/door-left-open.watch.json';
import fire from '../recipes/fire.watch.json';
import other from '../recipes/other.watch.json';
import packageAtDoor from '../recipes/package-at-door.watch.json';
import personInRestrictedZone from '../recipes/person-in-restricted-zone.watch.json';
import printFailure from '../recipes/3d-print-failure.watch.json';
import queueTooLong from '../recipes/queue-too-long.watch.json';
import robbery from '../recipes/robbery.watch.json';
import dashboardTurnsRed from '../recipes/dashboard-turns-red.watch.json';
import waterLeak from '../recipes/water-leak.watch.json';
import { findForbiddenKeys, type Recipe, RecipeSchema } from './schema';

export * from './models';
export * from './schema';

export class RecipeImportError extends Error {
  constructor(public readonly problems: string[]) {
    super(`recipe rejected: ${problems.join('; ')}`);
  }
}

/** Parses untrusted recipe JSON (a file, a paste, a PR). SG-18 is enforced here and in the strict schema. */
export function importRecipe(input: string | unknown): Recipe {
  let value: unknown = input;
  if (typeof input === 'string') {
    if (input.length > 20_000) throw new RecipeImportError(['recipe file is larger than 20 kB']);
    try {
      value = JSON.parse(input);
    } catch {
      throw new RecipeImportError(['not valid JSON']);
    }
  }
  const forbidden = findForbiddenKeys(value);
  if (forbidden.length > 0) {
    throw new RecipeImportError(forbidden.map((k) => `key '${k}' is not allowed in a recipe (routing, egress and actions stay in your own config)`));
  }
  const r = RecipeSchema.safeParse(value);
  if (!r.success) throw new RecipeImportError(r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  return r.data;
}

const RAW_BUILTINS: unknown[] = [
  fire,
  robbery,
  other,
  packageAtDoor,
  printFailure,
  dashboardTurnsRed,
  queueTooLong,
  waterLeak,
  doorLeftOpen,
  personInRestrictedZone,
];

export const BUILTIN_RECIPES: readonly Recipe[] = Object.freeze(RAW_BUILTINS.map((r) => importRecipe(r)));

export function builtinRecipe(id: string): Recipe | undefined {
  return BUILTIN_RECIPES.find((r) => r.id === id);
}
