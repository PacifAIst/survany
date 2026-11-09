/** Wire contracts between the extension and the backend. Both sides validate with these schemas. */
import { z } from 'zod';
import { ChannelSchema, ContactIdSchema, RuleIdSchema } from './config';
import { UUID_RE } from './ids';
import { SEVERITIES } from './viewer-meta';

const Uuid = z.string().regex(UUID_RE, 'must be a UUIDv4');
const IsoUtc = z.string().datetime({ offset: false });
export const MAX_SNAPSHOT_B64 = 2_800_000; // ~2 MB JPEG

export const PairDeviceRequestSchema = z
  .object({ code: z.string().regex(/^[A-Z2-9]{8}$/), name: z.string().min(1).max(60) })
  .strict();
export const PairDeviceResponseSchema = z.object({ deviceId: z.string(), deviceToken: z.string(), capabilities: z.lazy(() => CapabilitiesSchema) });

export const IceServerSchema = z.object({ urls: z.string(), username: z.string().optional(), credential: z.string().optional() });

export const CapabilitiesSchema = z.object({
  telegram: z.boolean(),
  email: z.boolean(),
  liveView: z.boolean(),
  actions: z.boolean(),
  proxy: z.boolean(),
  publicBaseUrl: z.string(),
  sourceUrl: z.string(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const UnconfirmedReasonSchema = z.enum(['all-providers-failed', 'budget', 'vision-disabled']);
export type UnconfirmedReason = z.infer<typeof UnconfirmedReasonSchema>;

export const EventSubmissionSchema = z
  .object({
    eventId: Uuid,
    rule: RuleIdSchema,
    ruleTitle: z.string().min(1).max(80),
    severity: z.enum(SEVERITIES),
    confirmed: z.boolean(),
    unconfirmedReason: UnconfirmedReasonSchema.nullable(),
    confidence: z.number().min(0).max(1),
    provider: z.string().max(40).nullable(),
    reason: z.string().max(4000),
    timestamp: IsoUtc,
    sourceLabel: z.string().max(200),
    recipients: z.array(ContactIdSchema).min(1).max(20),
    channels: z.array(ChannelSchema).min(1).max(2),
    snapshotJpegB64: z.string().max(MAX_SNAPSHOT_B64).nullable(),
    wantLiveView: z.boolean(),
  })
  .strict()
  .refine((e) => e.confirmed === (e.unconfirmedReason === null), 'unconfirmedReason must be set exactly when confirmed is false');
export type EventSubmission = z.infer<typeof EventSubmissionSchema>;

export const EventResponseSchema = z.object({
  eventId: Uuid,
  deduplicated: z.boolean(),
  stream: z
    .object({
      whipUrl: z.string(),
      expiresAt: IsoUtc,
      iceServers: z.array(z.object({ urls: z.string(), username: z.string().optional(), credential: z.string().optional() })),
    })
    .nullable(),
});
export type EventResponse = z.infer<typeof EventResponseSchema>;

export const HeartbeatSchema = z
  .object({
    armed: z.boolean(),
    sourceKind: z.enum(['tab', 'camera']).nullable(),
    sourceLabel: z.string().max(200),
    lastTickAt: IsoUtc.nullable(),
  })
  .strict();
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

export const NoticeKindSchema = z.enum([
  'budget-exhausted',
  'camera-offline',
  're-arm-needed',
  'offscreen-failed',
  'live-view-udp-unavailable',
  'channel-failing',
]);
export type NoticeKind = z.infer<typeof NoticeKindSchema>;
export const NoticeSchema = z.object({ kind: NoticeKindSchema, detail: z.string().max(500) }).strict();
export type Notice = z.infer<typeof NoticeSchema>;

export const ContactInviteRequestSchema = z
  .object({
    contactId: ContactIdSchema,
    roles: z.array(z.enum(['viewer', 'approver'])).min(1),
    email: z.string().email().nullable(),
    channels: z.array(ChannelSchema).min(1).max(2),
  })
  .strict();
export type ContactInviteRequest = z.infer<typeof ContactInviteRequestSchema>;

export const ContactStatusSchema = z.object({
  contactId: z.string(),
  roles: z.array(z.string()),
  telegramPaired: z.boolean(),
  emailSet: z.boolean(),
  pinSet: z.boolean(),
  lastTestOk: z.object({ telegram: IsoUtc.nullable(), email: IsoUtc.nullable() }),
});
export type ContactStatus = z.infer<typeof ContactStatusSchema>;

export const ActionProposalSchema = z
  .object({
    eventId: Uuid,
    tool: z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/),
    args: z.record(z.string().max(64), z.union([z.string().max(200), z.number(), z.boolean()])),
  })
  .strict();
export type ActionProposal = z.infer<typeof ActionProposalSchema>;

export const ProxyAnalyzeRequestSchema = z
  .object({
    providerId: z.enum(['anthropic', 'openai', 'openrouter', 'deepseek', 'local']),
    baseUrl: z.string().url(),
    model: z.string().min(1).max(200),
    imageJpegB64: z.string().max(MAX_SNAPSHOT_B64),
    prompt: z.string().max(4000),
    allowedEvents: z.array(z.string()).min(1).max(50),
    maxOutputTokens: z.number().int().min(50).max(2000),
  })
  .strict();
export type ProxyAnalyzeRequest = z.infer<typeof ProxyAnalyzeRequestSchema>;
