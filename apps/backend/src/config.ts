/** Backend configuration from the environment. The backend is the sole holder of the bot token, gate credentials and HMAC keys (§4.1). */
import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? null : v.trim()));

const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_BASE_URL: z.string().url(),
  DATA_DIR: z.string().default('./data'),
  TRUST_PROXY: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  TELEGRAM_BOT_TOKEN: optional,
  TELEGRAM_BOT_USERNAME: optional,
  TELEGRAM_WEBHOOK_SECRET: optional,
  TELEGRAM_API_BASE: z.string().url().default('https://api.telegram.org'),

  SMTP_URL: optional,
  MAIL_FROM: optional,

  OME_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  OME_PUBLIC_HOST: optional,
  OME_APP: z.string().default('app'),
  OME_SIGNALING_BASE: optional, // e.g. https://live.example.org (Caddy route to OME signaling)
  OME_LLHLS_BASE: optional, // e.g. https://live.example.org
  OME_ADMISSION_SECRET: optional,
  OME_API_URL: optional, // internal only, e.g. http://ome:8081
  OME_API_TOKEN: optional,
  FORWARD_AUTH_SECRET: optional,

  GATE_URL: optional, // e.g. http://gate:8000
  GATE_AGENT_TOKEN: optional,
  SERVER_HMAC_KEY: optional,

  MEDIA_RETENTION_HOURS: z.coerce.number().min(0).max(24 * 30).default(24),
  INITDATA_MAX_AGE_SEC: z.coerce.number().int().min(60).max(86_400).default(3600),
  PROXY_ALLOWED_HOSTS: z.string().default('api.anthropic.com,api.openai.com,openrouter.ai,api.deepseek.com'),
  PROXY_KEY_ANTHROPIC: optional,
  PROXY_KEY_OPENAI: optional,
  PROXY_KEY_OPENROUTER: optional,
  PROXY_KEY_DEEPSEEK: optional,
  SOURCE_URL: z.string().url().default('https://github.com/PacifAIst/survany'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const r = EnvSchema.safeParse(env);
  if (!r.success) {
    throw new Error(`invalid environment: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return r.data;
}

export interface Features {
  telegram: boolean;
  email: boolean;
  liveView: boolean;
  actions: boolean;
  proxy: boolean;
}

export function features(e: Env): Features {
  return {
    telegram: Boolean(e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_WEBHOOK_SECRET),
    email: Boolean(e.SMTP_URL && e.MAIL_FROM),
    liveView: Boolean(e.OME_ENABLED && e.OME_SIGNALING_BASE && e.OME_ADMISSION_SECRET && e.OME_PUBLIC_HOST),
    actions: Boolean(e.GATE_URL && e.TELEGRAM_BOT_TOKEN),
    proxy: Boolean(e.PROXY_KEY_ANTHROPIC ?? e.PROXY_KEY_OPENAI ?? e.PROXY_KEY_OPENROUTER ?? e.PROXY_KEY_DEEPSEEK),
  };
}
