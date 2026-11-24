CREATE TABLE "miirra_pay"."notification_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" bigint DEFAULT 0 NOT NULL,
	"body" text,
	"correlation_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"delivered_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notification_attempts_user_idx" ON "miirra_pay"."notification_attempts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_attempts_status_idx" ON "miirra_pay"."notification_attempts" USING btree ("status");