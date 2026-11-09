// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/** The e2e model mock passes the vision probe only by actually reading the code (it gets no other hint). */
import { expect, it } from 'vitest';
import { randomProbeCode, renderProbeImage } from '@survey-anything/providers';
import { readProbeCode } from '../../../packages/providers/test/probe-reader';

it('reads 200 random probe codes exactly from the probe PNG', () => {
  for (let i = 0; i < 200; i++) {
    const code = randomProbeCode();
    expect(readProbeCode(renderProbeImage(code))).toBe(code);
  }
});
