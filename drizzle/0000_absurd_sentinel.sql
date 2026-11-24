CREATE SCHEMA "miirra_pay";
--> statement-breakpoint
CREATE TABLE "miirra_pay"."commercial_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"external_id" text,
	"merchant_party_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"total_minor" bigint NOT NULL,
	"currency" text DEFAULT 'lyd' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"metadata" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "miirra_pay"."ledger_transfer_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transaction_id" uuid NOT NULL,
	"tb_transfer_id" text NOT NULL,
	"leg" text NOT NULL,
	"phase" text NOT NULL,
	"debit_account_id" text,
	"credit_account_id" text,
	"amount_minor" bigint NOT NULL,
	"code" integer NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "miirra_pay"."lypay_call_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation" text NOT NULL,
	"correlation_key" text,
	"http_status" integer,
	"error_code" text,
	"rate_limit_remaining" integer,
	"rate_limit_reset" bigint,
	"duration_ms" integer,
	"at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "miirra_pay"."payment_parties" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"platform_id" text NOT NULL,
	"display_name" text NOT NULL,
	"scheme_name" text,
	"identification" text,
	"institution_code" text,
	"tb_account_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "miirra_pay"."payment_state_transitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transaction_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"trigger" text NOT NULL,
	"cause_ref" text,
	"detail" text,
	"at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "miirra_pay"."payment_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"transaction_type" text NOT NULL,
	"direction" text DEFAULT 'outbound' NOT NULL,
	"sender_party_id" uuid,
	"receiver_party_id" uuid,
	"order_id" uuid,
	"principal_minor" bigint NOT NULL,
	"commission_minor" bigint DEFAULT 0 NOT NULL,
	"fee_minor" bigint DEFAULT 0 NOT NULL,
	"refundable_minor" bigint DEFAULT 0 NOT NULL,
	"internal_merchant_reference" text,
	"lypay_uuid" text,
	"payment_reference" text,
	"transaction_timestamp" bigint,
	"tb_ledger_phase" text DEFAULT 'none' NOT NULL,
	"tb_pending_debit_id" text,
	"tb_pending_credit_ids" text,
	"tb_refund_ids" text,
	"status" text DEFAULT 'acknowledged' NOT NULL,
	"status_message" text,
	"last_event" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"finalised_at" bigint
);
--> statement-breakpoint
CREATE TABLE "miirra_pay"."payment_webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_event_id" text NOT NULL,
	"webhook" text NOT NULL,
	"transaction_id" uuid,
	"signature_valid" boolean NOT NULL,
	"raw_body" text NOT NULL,
	"result" text DEFAULT 'pending' NOT NULL,
	"amount_minor" bigint,
	"received_at" bigint NOT NULL,
	"processed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "miirra_pay"."topup_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"deposit_reference" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"receiving_details" text,
	"status" text DEFAULT 'initiated' NOT NULL,
	"confirmed_transaction_id" uuid,
	"confirmed_by_event_id" uuid,
	"expires_at" bigint,
	"created_at" bigint NOT NULL,
	"confirmed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "miirra_pay"."unmatched_inbound_credits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"webhook_event_id" uuid,
	"deposit_reference" text,
	"amount_minor" bigint NOT NULL,
	"currency" text DEFAULT 'lyd' NOT NULL,
	"raw_payload" text NOT NULL,
	"resolution" text DEFAULT 'unmatched' NOT NULL,
	"resolved_by" text,
	"resolved_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_orders_reference_uq" ON "miirra_pay"."commercial_orders" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "commercial_orders_merchant_idx" ON "miirra_pay"."commercial_orders" USING btree ("merchant_party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_binding_transfer_uq" ON "miirra_pay"."ledger_transfer_bindings" USING btree ("tb_transfer_id");--> statement-breakpoint
CREATE INDEX "ledger_binding_tx_idx" ON "miirra_pay"."ledger_transfer_bindings" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "lypay_call_op_idx" ON "miirra_pay"."lypay_call_log" USING btree ("operation","at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_parties_kind_platform_uq" ON "miirra_pay"."payment_parties" USING btree ("kind","platform_id");--> statement-breakpoint
CREATE INDEX "payment_parties_platform_idx" ON "miirra_pay"."payment_parties" USING btree ("platform_id");--> statement-breakpoint
CREATE INDEX "state_transition_tx_idx" ON "miirra_pay"."payment_state_transitions" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_tx_idempotency_uq" ON "miirra_pay"."payment_transactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_tx_lypay_uuid_uq" ON "miirra_pay"."payment_transactions" USING btree ("lypay_uuid");--> statement-breakpoint
CREATE INDEX "payment_tx_sender_idx" ON "miirra_pay"."payment_transactions" USING btree ("sender_party_id");--> statement-breakpoint
CREATE INDEX "payment_tx_receiver_idx" ON "miirra_pay"."payment_transactions" USING btree ("receiver_party_id");--> statement-breakpoint
CREATE INDEX "payment_tx_status_idx" ON "miirra_pay"."payment_transactions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_event_provider_uq" ON "miirra_pay"."payment_webhook_events" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_event_tx_idx" ON "miirra_pay"."payment_webhook_events" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "webhook_event_result_idx" ON "miirra_pay"."payment_webhook_events" USING btree ("result");--> statement-breakpoint
CREATE UNIQUE INDEX "topup_intent_idempotency_uq" ON "miirra_pay"."topup_intents" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "topup_intent_deposit_ref_uq" ON "miirra_pay"."topup_intents" USING btree ("deposit_reference");--> statement-breakpoint
CREATE INDEX "topup_intent_user_idx" ON "miirra_pay"."topup_intents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "topup_intent_status_idx" ON "miirra_pay"."topup_intents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "unmatched_credits_resolution_idx" ON "miirra_pay"."unmatched_inbound_credits" USING btree ("resolution");--> statement-breakpoint
CREATE INDEX "unmatched_credits_ref_idx" ON "miirra_pay"."unmatched_inbound_credits" USING btree ("deposit_reference");