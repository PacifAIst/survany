// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
import type { Features, Env } from './config';
import type { Db } from './db/migrate';
import type { Mailer } from './alerts/email';
import type { TelegramApi } from './alerts/telegram';
import type { OmeClient } from './stream/ome-client';
import type { GateClient } from './actions/gate-client';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface AppCtx {
  db: Db;
  env: Env;
  feats: Features;
  telegram: TelegramApi | null;
  mailer: Mailer | null;
  ome: OmeClient | null;
  gate: GateClient | null;
  mediaDir: string;
  now: () => number;
  log: Logger;
}

export function publicHost(ctx: AppCtx): string {
  return new URL(ctx.env.PUBLIC_BASE_URL).hostname;
}

export function iceServers(ctx: AppCtx): { urls: string; username?: string; credential?: string }[] {
  // OME's built-in TcpRelay (D11). Its fixed default credentials are not a secret: the relay only hands data to OME in-process.
  const host = ctx.env.OME_PUBLIC_HOST;
  return host ? [{ urls: `turn:${host}:3478?transport=tcp`, username: 'ome', credential: 'airen' }] : [];
}
