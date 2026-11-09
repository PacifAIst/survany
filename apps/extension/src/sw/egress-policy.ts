// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SECURITY-GATE SG-15: frame egress requires its explicit flag across snapshot, clip, email and OME; without it the bytes are stripped before any request is built.
 * C13: allowCloudProviders:false does not by itself permit alert media; only egress.alertMedia does.
 */
import type { Config, EventSubmission } from '@survey-anything/shared';

export function canSendAlertMedia(c: Pick<Config, 'egress'>): boolean {
  return c.egress.alertMedia;
}

export function canStreamLive(c: Pick<Config, 'egress'>): boolean {
  return c.egress.liveView;
}

export function canUploadClip(c: Pick<Config, 'egress'>): boolean {
  return c.egress.alertMedia;
}

/** Email snapshot also honours the per-channel includeSnapshot preference. */
export function canEmailSnapshot(c: Pick<Config, 'egress' | 'alerts'>): boolean {
  return c.egress.alertMedia && c.alerts.email.includeSnapshot;
}

export function applyEgressPolicy(sub: EventSubmission, c: Pick<Config, 'egress'>): EventSubmission {
  return {
    ...sub,
    snapshotJpegB64: canSendAlertMedia(c) ? sub.snapshotJpegB64 : null,
    wantLiveView: sub.wantLiveView && canStreamLive(c),
  };
}
