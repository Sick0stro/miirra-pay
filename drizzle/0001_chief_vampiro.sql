CREATE TABLE "miirra_pay"."didit_webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"didit_event_id" text NOT NULL,
	"webhook_type" text NOT NULL,
	"session_id" text,
	"status" text,
	"signature_valid" boolean NOT NULL,
	"raw_body" text NOT NULL,
	"result" text DEFAULT 'pending' NOT NULL,
	"received_at" bigint NOT NULL,
	"processed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "miirra_pay"."vendor_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vendor_id" text NOT NULL,
	"branch_id" text,
	"import_record_id" text,
	"didit_session_id" text NOT NULL,
	"vendor_data" text NOT NULL,
	"vendor_data_raw" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"document_type" text,
	"face_match_score" numeric(5, 4),
	"last_event_id" text,
	"verified_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "didit_webhook_event_uq" ON "miirra_pay"."didit_webhook_events" USING btree ("didit_event_id");--> statement-breakpoint
CREATE INDEX "didit_webhook_session_idx" ON "miirra_pay"."didit_webhook_events" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_verifications_didit_session_uq" ON "miirra_pay"."vendor_verifications" USING btree ("didit_session_id");--> statement-breakpoint
CREATE INDEX "vendor_verifications_vendor_idx" ON "miirra_pay"."vendor_verifications" USING btree ("vendor_id","branch_id");--> statement-breakpoint
CREATE INDEX "vendor_verifications_status_idx" ON "miirra_pay"."vendor_verifications" USING btree ("status");