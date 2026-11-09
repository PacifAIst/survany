/**
 * Operator CLI, run inside the backend container:
 *   node dist/cli.js pair-device                 -> prints a one-time device pairing code (10 min)
 *   node dist/cli.js gate-pair <code>            -> pairs the backend as confirm-gate's device
 *   node dist/cli.js verify-audit                -> verifies the audit hash chain (SG-22)
 */
import { join } from 'node:path';
import { ConfirmGateClient } from './actions/gate-client';
import { appendAudit, verifyAuditChain } from './actions/audit';
import { loadEnv } from './config';
import type { AppCtx } from './context';
import { openDb } from './db/migrate';
import { createPairingCode } from './routes/pairing';

async function main(argv: string[]): Promise<number> {
  const env = loadEnv();
  const db = openDb(join(env.DATA_DIR, 'survey-anything.db'));
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'pair-device': {
      const ctx = { db, now: Date.now } as unknown as AppCtx;
      const code = createPairingCode(ctx);
      console.info(`Device pairing code: ${code}  (valid 10 minutes, single use)`);
      return 0;
    }
    case 'gate-pair': {
      if (!env.GATE_URL) throw new Error('GATE_URL is not set');
      const code = rest[0];
      if (!code) throw new Error('usage: gate-pair <code>');
      const d = await ConfirmGateClient.pair(env.GATE_URL, code, 'survey-anything-backend');
      db.prepare("INSERT INTO meta(key, value) VALUES ('gate_device', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ deviceId: d.deviceId, key: d.key }));
      appendAudit(db, 'gate.paired', { deviceId: d.deviceId, userId: d.userId });
      console.info(`Paired with the gate as ${d.deviceId}. Restart the backend to load the credentials.`);
      return 0;
    }
    case 'verify-audit': {
      const r = verifyAuditChain(db);
      console.info(r.ok ? `audit chain OK (${r.rows} rows)` : `audit chain BROKEN at seq ${r.brokenAt}`);
      return r.ok ? 0 : 2;
    }
    default:
      console.error('commands: pair-device | gate-pair <code> | verify-audit');
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
