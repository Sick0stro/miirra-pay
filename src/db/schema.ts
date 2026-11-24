/**
 * Miirra Pay — Neon Postgres schema (system of record).
 *
 * Runs in its OWN `miirra_pay` schema inside the same Neon database cluster as
 * the rest of the platform (`miirra_auth_db`). It is isolated so a payments
 * migration can never disturb the orders API — but it can still join to
 * `public."user"` for identity when it must.
 *
 * CONVENTIONS (matching miirra-api exactly):
 *  - All timestamps are BIGINT ms-since-epoch (contract TimestampSchema).
 *  - Money is stored as BIGINT MINOR UNITS (LYD piastres), never numeric — a
 *    payments ledger must not carry floats, and the authoritative money is in
 *    TigerBeetle anyway. This DB holds the *linkage* and *state*, not balances.
 *  - u128 TigerBeetle ids (account/transfer) are TEXT decimal strings — Postgres
 *    cannot hold u128 and these must round-trip without precision loss.
 */

import {
  bigint,
  boolean,
  index,
  integer,
  numeric,
  pgSchema,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const schema = pgSchema('miirra_pay');

// ── Payment parties ──────────────────────────────────────────────────────────
// A party is the "who" of a payment: a natural person (payer/payee) or a
// merchant/branch. Both map onto LYPay's debtor/creditor Account objects. The
// `kind` discriminator is what lets the same table hold consumers and merchants.

export const paymentParties = schema.table(
  'payment_parties',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').$type<'person' | 'merchant'>().notNull(),
    /** Platform user id (public."user".id) for persons; org/vendor id for merchants. */
    platformId: text('platform_id').notNull(),
    displayName: text('display_name').notNull(),
    /** LYPay schemeName, e.g. 'iban'. */
    schemeName: text('scheme_name'),
    /** The account identifier LYPay credits/debits (IBAN / alias). */
    identification: text('identification'),
    /** LYPay institution code when this party banks at a specific institution. */
    institutionCode: text('institution_code'),
    /** TigerBeetle account id (u128 decimal string), assigned once. */
    tbAccountId: text('tb_account_id'),
    active: boolean('active').notNull().default(true),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    // One party row per (kind, platformId) — provisioning is idempotent.
    uniqueIndex('payment_parties_kind_platform_uq').on(t.kind, t.platformId),
    index('payment_parties_platform_idx').on(t.platformId),
  ],
);

// ── Commercial orders ────────────────────────────────────────────────────────
// The business context a payment settles against: a merchant checkout, a
// catering booking, a procurement order. Payments reference an order; the order
// references a merchant party. Kept deliberately thin — the rich order lives in
// miirra-api / the vendor app; this is the financial join point.

export const commercialOrders = schema.table(
  'commercial_orders',
  {
    id: uuid('id').primaryKey(),
    /** External order id (e.g. miirra-api order id or vendor POS order id). */
    externalId: text('external_id'),
    merchantPartyId: uuid('merchant_party_id').notNull(),
    /** Short human reference shown on receipts. */
    reference: text('reference').notNull(),
    /** Minor-unit total the order expects to collect. */
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('lyd'),
    status: text('status').notNull().default('open'), // open | paid | refunded | cancelled
    metadata: text('metadata'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('commercial_orders_reference_uq').on(t.reference),
    index('commercial_orders_merchant_idx').on(t.merchantPartyId),
  ],
);

// ── Payment transactions ─────────────────────────────────────────────────────
// The central ledger of record for every payment attempt and its two-phase
// TigerBeetle state. `tb_ledger_phase` tracks pending → posted/voided; the
// `*_tb_transfer_id` columns hold the u128 ids as decimal strings so a crash
// between "create pending" and "persist the ids" is recoverable by re-deriving
// them (they are deterministic from `id`).

export const paymentTransactions = schema.table(
  'payment_transactions',
  {
    id: uuid('id').primaryKey(),
    /** Client-supplied idempotency key — unique per (idempotency scope). */
    idempotencyKey: text('idempotency_key').notNull(),
    /** The LYPay transaction type: P2P | P2M | M2M | M2P. */
    transactionType: text('transaction_type')
      .$type<'P2P' | 'P2M' | 'M2M' | 'M2P'>()
      .notNull(),
    direction: text('direction').$type<'outbound' | 'refund'>().notNull().default('outbound'),

    senderPartyId: uuid('sender_party_id'),
    receiverPartyId: uuid('receiver_party_id'),
    /** Commercial order this payment settles (P2M/M2M), if any. */
    orderId: uuid('order_id'),

    /** Minor-unit amounts. */
    principalMinor: bigint('principal_minor', { mode: 'number' }).notNull(),
    commissionMinor: bigint('commission_minor', { mode: 'number' }).notNull().default(0),
    feeMinor: bigint('fee_minor', { mode: 'number' }).notNull().default(0),
    /** Amount still refundable (minor units), decremented by each refund. */
    refundableMinor: bigint('refundable_minor', { mode: 'number' }).notNull().default(0),

    /** Our internal LYPay correlation. */
    internalMerchantReference: text('internal_merchant_reference'),
    /** LYPay-assigned identifiers, captured from initiate/confirm. */
    lypayUuid: text('lypay_uuid'),
    paymentReference: text('payment_reference'),
    transactionTimestamp: bigint('transaction_timestamp', { mode: 'number' }),

    /** Two-phase ledger state. */
    tbLedgerPhase: text('tb_ledger_phase')
      .$type<'none' | 'pending' | 'posted' | 'voided' | 'refunded'>()
      .notNull()
      .default('none'),
    /** u128 transfer ids (decimal strings) for the pending chain / refund. */
    tbPendingDebitId: text('tb_pending_debit_id'),
    tbPendingCreditIds: text('tb_pending_credit_ids'), // JSON array of decimal strings
    tbRefundIds: text('tb_refund_ids'), // JSON array of decimal strings

    /** LYPay status at last update. */
    status: text('status')
      .$type<'acknowledged' | 'processing' | 'completed' | 'declined' | 'failed'>()
      .notNull()
      .default('acknowledged'),
    statusMessage: text('status_message'),

    /** What triggered the last transition (initiate/confirm/webhook/refund). */
    lastEvent: text('last_event'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    /** Set when the transaction reaches a final state (completed/declined/voided). */
    finalisedAt: bigint('finalised_at', { mode: 'number' }),
  },
  (t) => [
    // Idempotency: one logical payment per key. Scope is the route namespace
    // (topup vs payment) folded into the key by the caller, so a payment and a
    // top-up can never collide on the same key value.
    uniqueIndex('payment_tx_idempotency_uq').on(t.idempotencyKey),
    uniqueIndex('payment_tx_lypay_uuid_uq').on(t.lypayUuid),
    index('payment_tx_sender_idx').on(t.senderPartyId),
    index('payment_tx_receiver_idx').on(t.receiverPartyId),
    index('payment_tx_status_idx').on(t.status),
  ],
);

// ── Ledger transfer bindings ─────────────────────────────────────────────────
// An explicit record linking a payment transaction to the TigerBeetle
// transfers that realise it. This is the audit spine: "this tx id maps to these
// tb transfer ids, at this phase". Reconciliation reads this to prove the
// ledger and the DB agree.

export const ledgerTransferBindings = schema.table(
  'ledger_transfer_bindings',
  {
    id: uuid('id').primaryKey(),
    transactionId: uuid('transaction_id').notNull(),
    /** u128 transfer id (decimal string). */
    tbTransferId: text('tb_transfer_id').notNull(),
    /** Which logical leg: debit | credit:<i> | post:<id> | void:<id> | refund:principal | ... */
    leg: text('leg').notNull(),
    /** pending | posted | voided */
    phase: text('phase').$type<'pending' | 'posted' | 'voided'>().notNull(),
    /** u128 debit account id (decimal string). */
    debitAccountId: text('debit_account_id'),
    /** u128 credit account id (decimal string). */
    creditAccountId: text('credit_account_id'),
    /** Minor-unit amount for this leg. */
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    code: integer('code').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('ledger_binding_transfer_uq').on(t.tbTransferId),
    index('ledger_binding_tx_idx').on(t.transactionId),
  ],
);

// ── Payment state transitions ────────────────────────────────────────────────
// Append-only audit of every status change: what moved, when, because of what.
// Never updated or deleted — this is the forensic record.

export const paymentStateTransitions = schema.table(
  'payment_state_transitions',
  {
    id: uuid('id').primaryKey(),
    transactionId: uuid('transaction_id').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    /** The trigger: initiate | confirm | webhook:transaction_status_update | refund | system. */
    trigger: text('trigger').notNull(),
    /** Webhook event id / LYPay reference that caused this, when applicable. */
    causeRef: text('cause_ref'),
    detail: text('detail'),
    at: bigint('at', { mode: 'number' }).notNull(),
  },
  (t) => [index('state_transition_tx_idx').on(t.transactionId)],
);

// ── Payment webhook events ───────────────────────────────────────────────────
// Raw inbound webhook events, deduplicated by `provider_event_id` BEFORE any
// state mutation. HMAC is verified before the row is even written; a replayed
// event id is a no-op.

export const paymentWebhookEvents = schema.table(
  'payment_webhook_events',
  {
    id: uuid('id').primaryKey(),
    /** LYPay's event id (falls back to a hash of the canonical body if absent). */
    providerEventId: text('provider_event_id').notNull(),
    /** webhook kind: transaction_status_update | transaction_credit_notice */
    webhook: text('webhook').notNull(),
    /** The matching payment transaction, once resolved (nullable for unmatched credits). */
    transactionId: uuid('transaction_id'),
    /** Verified HMAC signature that authenticated this delivery. */
    signatureValid: boolean('signature_valid').notNull(),
    /** Raw body, verbatim, for forensics. */
    rawBody: text('raw_body').notNull(),
    /** Processing result: processed | duplicate | unmatched | error */
    result: text('result').notNull().default('pending'),
    /** Minor-unit amount when the event carries one. */
    amountMinor: bigint('amount_minor', { mode: 'number' }),
    receivedAt: bigint('received_at', { mode: 'number' }).notNull(),
    processedAt: bigint('processed_at', { mode: 'number' }),
  },
  (t) => [
    // The dedupe guarantee: one row per provider event.
    uniqueIndex('webhook_event_provider_uq').on(t.providerEventId),
    index('webhook_event_tx_idx').on(t.transactionId),
    index('webhook_event_result_idx').on(t.result),
  ],
);

// ── Unmatched inbound credits ────────────────────────────────────────────────
// Inbound credits that arrived but could NOT be matched to a deposit reference
// or amount. They are NEVER dropped — they land here for manual reconciliation,
// and the alerting path surfaces them.

export const unmatchedInboundCredits = schema.table(
  'unmatched_inbound_credits',
  {
    id: uuid('id').primaryKey(),
    /** The webhook event id that carried this credit. */
    webhookEventId: uuid('webhook_event_id'),
    /** Any deposit reference we could extract (often null — that's why it's unmatched). */
    depositReference: text('deposit_reference'),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('lyd'),
    /** Raw debtor/creditor/numo fields, for a human to trace. */
    rawPayload: text('raw_payload').notNull(),
    /** unmatched | matched_manually | refunded | written_off */
    resolution: text('resolution').notNull().default('unmatched'),
    resolvedBy: text('resolved_by'),
    resolvedAt: bigint('resolved_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('unmatched_credits_resolution_idx').on(t.resolution),
    index('unmatched_credits_ref_idx').on(t.depositReference),
  ],
);

// ── Top-up intents ───────────────────────────────────────────────────────────
// The user's top-up intent: a unique deposit reference + the platform receiving
// details the user transfers to. A top-up is confirmed ONLY when an inbound
// credit matches this reference + amount — never on a client claim.

export const topupIntents = schema.table(
  'topup_intents',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id').notNull(),
    /** Client-supplied idempotency key, unique. */
    idempotencyKey: text('idempotency_key').notNull(),
    /** The unique deposit reference the user must quote on their bank transfer. */
    depositReference: text('deposit_reference').notNull(),
    /** Minor-unit amount the user intends to add. */
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    /** LYPay/NAD/IBAN receiving details shown to the user. */
    receivingDetails: text('receiving_details'),
    /** state: initiated | confirmed | unmatched | expired | cancelled */
    status: text('status')
      .$type<'initiated' | 'confirmed' | 'unmatched' | 'expired' | 'cancelled'>()
      .notNull()
      .default('initiated'),
    /** The payment_transaction id created when confirmed, if any. */
    confirmedTransactionId: uuid('confirmed_transaction_id'),
    /** The webhook event that confirmed it. */
    confirmedByEventId: uuid('confirmed_by_event_id'),
    expiresAt: bigint('expires_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    confirmedAt: bigint('confirmed_at', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('topup_intent_idempotency_uq').on(t.idempotencyKey),
    uniqueIndex('topup_intent_deposit_ref_uq').on(t.depositReference),
    index('topup_intent_user_idx').on(t.userId),
    index('topup_intent_status_idx').on(t.status),
  ],
);

// ── Outbound LYPay idempotency / rate-limit ledger ───────────────────────────
// Records every LYPay API call we make (token, initiate, confirm, refund, status)
// so retries are safe and the 300 req/min budget is observable. Not strictly
// required by the brief, but it is what makes the two-step flow auditable.

export const lypayCallLog = schema.table(
  'lypay_call_log',
  {
    id: uuid('id').primaryKey(),
    /** Which operation: token | initiate | confirm | refund | status | details */
    operation: text('operation').notNull(),
    /** Our correlation key (transaction id or 'token'). */
    correlationKey: text('correlation_key'),
    httpStatus: integer('http_status'),
    /** LYPay error code if the call failed, e.g. AUT-003 / VAL-001. */
    errorCode: text('error_code'),
    rateLimitRemaining: integer('rate_limit_remaining'),
    rateLimitReset: bigint('rate_limit_reset', { mode: 'number' }),
    durationMs: integer('duration_ms'),
    at: bigint('at', { mode: 'number' }).notNull(),
  },
  (t) => [index('lypay_call_op_idx').on(t.operation, t.at)],
);

// ── Vendor / branch verifications (Didit KYC/KYB) ────────────────────────────
// One row per Didit verification session, linked to the vendor/branch (and
// optionally the import record) it onboards. Tracks the session id, the full
// vendor_data echo, the lifecycle status, and the face-match score. Webhook
// events are deduplicated by `didit_event_id` before any mutation, and an
// already-`approved` row is never downgraded.

export const vendorVerifications = schema.table(
  'vendor_verifications',
  {
    id: uuid('id').primaryKey(),
    /** The vendor / branch this verification onboards. */
    vendorId: text('vendor_id').notNull(),
    /** Optional branch within the vendor (multi-branch merchants). */
    branchId: text('branch_id'),
    /** Optional import record that introduced this vendor. */
    importRecordId: text('import_record_id'),
    /** Didit session UUID. */
    diditSessionId: text('didit_session_id').notNull(),
    /** The vendor_data we sent (our stable id for the entity). */
    vendorData: text('vendor_data').notNull(),
    /** Echo of the Didit metadata (JSON). */
    vendorData_raw: text('vendor_data_raw'),
    /** pending | started | approved | declined | expired | failed */
    status: text('status')
      .$type<'pending' | 'started' | 'approved' | 'declined' | 'expired' | 'failed'>()
      .notNull()
      .default('pending'),
    /** Didit document_type from the decision (e.g. 'ID', 'P', 'DL'). */
    documentType: text('document_type'),
    /** Face-match score (0..1) from the decision's face_matches[]. */
    faceMatchScore: numeric('face_match_score', { precision: 5, scale: 4 }),
    /** Last Didit event id that touched this row (for dedupe + audit). */
    lastEventId: text('last_event_id'),
    /** Set when the session reaches a terminal success state. */
    verifiedAt: bigint('verified_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('vendor_verifications_didit_session_uq').on(t.diditSessionId),
    index('vendor_verifications_vendor_idx').on(t.vendorId, t.branchId),
    index('vendor_verifications_status_idx').on(t.status),
  ],
);

// ── Didit webhook event dedupe ────────────────────────────────────────────────
// Raw inbound Didit events, deduplicated by event_id BEFORE mutating a
// vendor_verifications row.

export const diditWebhookEvents = schema.table(
  'didit_webhook_events',
  {
    id: uuid('id').primaryKey(),
    diditEventId: text('didit_event_id').notNull(),
    webhookType: text('webhook_type').notNull(),
    sessionId: text('session_id'),
    status: text('status'),
    signatureValid: boolean('signature_valid').notNull(),
    rawBody: text('raw_body').notNull(),
    /** processed | duplicate | error */
    result: text('result').notNull().default('pending'),
    receivedAt: bigint('received_at', { mode: 'number' }).notNull(),
    processedAt: bigint('processed_at', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('didit_webhook_event_uq').on(t.diditEventId),
    index('didit_webhook_session_idx').on(t.sessionId),
  ],
);

// ── Notification attempts ─────────────────────────────────────────────────────
// Best-effort delivery log. A row exists for every notify() attempt so a retry
// worker can re-drive failures. A notification failure NEVER rolls back a
// confirmed payment — this table is downstream of the ledger, not part of it.

export const notificationAttempts = schema.table(
  'notification_attempts',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id').notNull(),
    /** wallet_received | payment_confirmed | topup_confirmed */
    kind: text('kind').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull().default(0),
    body: text('body'),
    /** Correlation id (transaction id). */
    correlationId: text('correlation_id'),
    /** pending | delivered | failed */
    status: text('status').$type<'pending' | 'delivered' | 'failed'>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(1),
    lastError: text('last_error'),
    deliveredAt: bigint('delivered_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('notification_attempts_user_idx').on(t.userId),
    index('notification_attempts_status_idx').on(t.status),
  ],
);