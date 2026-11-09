// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/** OME AdmissionWebhooks endpoint and the Caddy forward_auth endpoint (SG-11). */
import type { FastifyInstance } from 'fastify';
import { appendAudit } from '../actions/audit';
import type { AppCtx } from '../context';
import { safeEqual } from '../security/hmac';
import { type AdmissionRequest, decideAdmission, decideForwardAuth, verifyOmeSignature } from '../stream/admission';

export function registerOmeRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.post('/ome/admission', async (req, reply) => {
    const secret = ctx.env.OME_ADMISSION_SECRET;
    // Unknown means deny: without a secret nothing can be verified, so nothing is admitted.
    if (!secret) return reply.code(503).send({ allowed: false, reason: 'admission not configured' });
    const sig = req.headers['x-ome-signature'];
    if (!req.rawBody || !verifyOmeSignature(secret, req.rawBody, typeof sig === 'string' ? sig : undefined)) {
      ctx.log.warn({ ip: req.ip }, 'OME admission: bad signature');
      return reply.code(401).send({ allowed: false, reason: 'bad signature' });
    }
    const decision = decideAdmission(ctx.db, ctx.env.OME_APP, req.body as AdmissionRequest, ctx.now());
    const r = (req.body as AdmissionRequest).request;
    if ('allowed' in decision && !decision.allowed) {
      appendAudit(ctx.db, 'admission.denied', { direction: r?.direction, protocol: r?.protocol, reason: decision.reason });
    }
    return decision;
  });

  app.get('/ome/forward-auth', async (req, reply) => {
    const shared = ctx.env.FORWARD_AUTH_SECRET;
    const got = req.headers['x-sa-forward-auth'];
    if (shared && (typeof got !== 'string' || !safeEqual(got, shared))) return reply.code(403).send('forbidden');
    const uri = req.headers['x-forwarded-uri'];
    const d = decideForwardAuth(ctx.db, ctx.env.OME_APP, typeof uri === 'string' ? uri : undefined, ctx.now());
    return d.ok ? reply.code(200).send('ok') : reply.code(403).send('forbidden');
  });
}
