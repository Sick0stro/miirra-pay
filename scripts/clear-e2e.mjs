// Best-effort cleanup of E2E data from the miirra_pay schema.
import { Pool } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
const url = readFileSync('.dev.vars', 'utf8').match(/^DATABASE_URL="?(.+?)"?$/m)[1];
const p = new Pool({ connectionString: url });
try {
  await p.query(`DELETE FROM miirra_pay.unmatched_inbound_credits`);
  await p.query(`DELETE FROM miirra_pay.payment_state_transitions`);
  await p.query(`DELETE FROM miirra_pay.ledger_transfer_bindings`);
  await p.query(`DELETE FROM miirra_pay.payment_webhook_events`);
  await p.query(`DELETE FROM miirra_pay.topup_intents`);
  await p.query(`DELETE FROM miirra_pay.payment_transactions`);
  console.log('e2e data cleared');
} finally {
  await p.end();
}