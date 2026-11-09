// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
declare module 'ovenplayer' {
  const OvenPlayer: { create(id: string, options: Record<string, unknown>): unknown };
  export default OvenPlayer;
}
