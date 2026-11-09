-- Survey Anything backend schema v1 (SQLite).
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  roles TEXT NOT NULL,
  channels TEXT NOT NULL,
  telegram_user_id TEXT,
  telegram_chat_id TEXT,
  email TEXT,
  pin_hash TEXT,
  created_at INTEGER NOT NULL,
  paired_at INTEGER,
  last_test_telegram INTEGER,
  last_test_email INTEGER
);

CREATE TABLE IF NOT EXISTS contact_invites (
  token_hash TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('telegram', 'pin')),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  rule TEXT NOT NULL,
  rule_title TEXT NOT NULL,
  severity TEXT NOT NULL,
  confirmed INTEGER NOT NULL,
  unconfirmed_reason TEXT,
  confidence REAL NOT NULL,
  provider TEXT,
  reason TEXT NOT NULL,
  ts TEXT NOT NULL,
  source_label TEXT NOT NULL,
  recipients TEXT NOT NULL,
  channels TEXT NOT NULL,
  ack_timeout_sec INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  acked_at INTEGER,
  acked_by TEXT,
  ack_channel TEXT,
  escalation_stage INTEGER NOT NULL DEFAULT 0,
  snapshot_path TEXT,
  clip_path TEXT,
  clip_mime TEXT,
  clip_wanted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS outbox (
  key TEXT PRIMARY KEY,
  event_id TEXT,
  contact_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'email')),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  sent_at INTEGER,
  provider_message_id TEXT
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status, next_at);

CREATE TABLE IF NOT EXISTS streams (
  id TEXT PRIMARY KEY,
  event_id TEXT,
  device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  live_at INTEGER,
  ended_at INTEGER,
  probe INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stream_tokens (
  token_hash TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('publisher', 'viewer', 'play', 'probe')),
  contact_id TEXT,
  channel TEXT,
  expires_at INTEGER NOT NULL,
  session_hash TEXT,
  parent_hash TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ack_tokens (
  token_hash TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS pin_attempts (
  contact_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pin_attempts_contact ON pin_attempts(contact_id, at);

CREATE TABLE IF NOT EXISTS pin_lockouts (
  contact_id TEXT PRIMARY KEY,
  until INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS heartbeats (
  device_id TEXT PRIMARY KEY,
  last_at INTEGER NOT NULL,
  armed INTEGER NOT NULL,
  source_kind TEXT,
  source_label TEXT,
  dead_alerted_at INTEGER
);

CREATE TABLE IF NOT EXISTS probe_reports (
  at INTEGER NOT NULL,
  device_id TEXT,
  stream_id TEXT,
  side TEXT NOT NULL,
  candidate_type TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  card_text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'executed', 'failed')),
  decided_by TEXT,
  decided_at INTEGER,
  gate_pending_id TEXT,
  result TEXT
);

CREATE TABLE IF NOT EXISTS approval_messages (
  approval_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
