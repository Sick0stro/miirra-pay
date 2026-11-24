CREATE TABLE "miirra_pay"."audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text,
	"entity_id" text,
	"amount_minor" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'LYD' NOT NULL,
	"detail" text,
	"hash" text NOT NULL,
	"prev_hash" text NOT NULL,
	"at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "miirra_pay"."consent_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"purpose" text NOT NULL,
	"state" text NOT NULL,
	"text_version" text,
	"recorded_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "miirra_pay"."consumer_cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"subject" text NOT NULL,
	"detail" text,
	"sla_due_at" bigint,
	"resolved_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audit_log_seq_uq" ON "miirra_pay"."audit_log" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "miirra_pay"."audit_log" USING btree ("actor");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "miirra_pay"."audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "consent_records_user_idx" ON "miirra_pay"."consent_records" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "consumer_cases_user_idx" ON "miirra_pay"."consumer_cases" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "consumer_cases_status_idx" ON "miirra_pay"."consumer_cases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "consumer_cases_sla_idx" ON "miirra_pay"."consumer_cases" USING btree ("sla_due_at");