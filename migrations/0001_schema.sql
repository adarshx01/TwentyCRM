CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"channel" varchar(20),
	"source_event_id" varchar(255),
	"action" varchar(100) NOT NULL,
	"resource_type" varchar(50),
	"resource_id" varchar(255),
	"changed_fields" jsonb,
	"confirmation_id" varchar(255),
	"result" varchar(20),
	"correlation_id" varchar(255),
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb
);

CREATE TABLE "channel_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" varchar(20) NOT NULL,
	"external_id" varchar(512) NOT NULL,
	"connection_id" varchar(512) NOT NULL,
	"conversation_ref" jsonb,
	"last_inbound_at" timestamp with time zone,
	"opted_out" boolean DEFAULT false NOT NULL,
	"enrolled_by" uuid,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	CONSTRAINT "channel_bindings_unique" UNIQUE("channel","connection_id","external_id","tenant_id")
);

CREATE TABLE "conversation_sessions" (
	"channel" varchar(20) NOT NULL,
	"connection_id" varchar(512) NOT NULL,
	"external_id" varchar(512) NOT NULL,
	"active_tenant_id" uuid,
	"pending_choices" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_sessions_pk" UNIQUE("channel","connection_id","external_id")
);

CREATE TABLE "crm_index" (
	"tenant_id" uuid NOT NULL,
	"entity" varchar(30) NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"owner_member_id" varchar(255),
	"team_id" varchar(255),
	"stage_id" varchar(100),
	"status" varchar(30),
	"due_at" timestamp with time zone,
	"archived" boolean DEFAULT false NOT NULL,
	"remote_updated_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_index_pk" UNIQUE("tenant_id","entity","external_id")
);

CREATE TABLE "dead_letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"queue" varchar(100) NOT NULL,
	"job_id" varchar(64),
	"payload" jsonb,
	"error" text,
	"correlation_id" varchar(255),
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "delivery_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"channel" varchar(20) NOT NULL,
	"message_type" varchar(30) NOT NULL,
	"external_message_id" varchar(255),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"payload" jsonb,
	"deferred_payload" jsonb,
	"sending_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"error_info" jsonb,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_state_idempotency_key_unique" UNIQUE("idempotency_key")
);

CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" varchar(512) NOT NULL,
	"channel" varchar(20) NOT NULL,
	"kind" varchar(30) DEFAULT 'capture' NOT NULL,
	"state" varchar(25) DEFAULT 'collecting' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"content_hash" varchar(64),
	"proposed_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extracted_data" jsonb,
	"source_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preview_message_id" varchar(255),
	"operation_id" uuid,
	"media_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"channel" varchar(20) NOT NULL,
	"expected_external_id" varchar(512),
	"created_by" varchar(255) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollments_code_hash_unique" UNIQUE("code_hash")
);

CREATE TABLE "idempotency_keys" (
	"key" varchar(512) PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"operation_id" uuid,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);

CREATE TABLE "inbound_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_event_id" varchar(512) NOT NULL,
	"channel" varchar(20) NOT NULL,
	"tenant_id" uuid,
	"user_id" uuid,
	"event_type" varchar(50),
	"payload" jsonb,
	"processed_at" timestamp with time zone,
	"correlation_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_events_dedup" UNIQUE("channel","provider_event_id")
);

CREATE TABLE "intake_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"state" varchar(20) DEFAULT 'received' NOT NULL,
	"operation_id" uuid,
	"delivery_idempotency_key" varchar(512) NOT NULL,
	"message_id" varchar(512),
	"submission_id" varchar(512),
	"content_fingerprint" varchar(64),
	"raw_email_ref" varchar(512),
	"parsed_fields" jsonb,
	"proposed_actions" jsonb,
	"review_reason" varchar(255),
	"reviewed_by" varchar(255),
	"reviewed_at" timestamp with time zone,
	"crm_review_id" varchar(255),
	"auth_evidence" jsonb,
	"parser_version" varchar(20),
	"timestamps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_records_delivery_idempotency_key_unique" UNIQUE("delivery_idempotency_key")
);

CREATE TABLE "intake_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" varchar(255) NOT NULL,
	"intake_alias" varchar(512),
	"type" varchar(20) NOT NULL,
	"form_label" varchar(255),
	"parsing_rules" jsonb NOT NULL,
	"crm_routing" jsonb NOT NULL,
	"follow_up_config" jsonb,
	"webhook_secret_ref" varchar(512),
	"mailbox" jsonb,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_sources_source_id_unique" UNIQUE("source_id"),
	CONSTRAINT "intake_sources_intake_alias_unique" UNIQUE("intake_alias")
);

CREATE TABLE "mailbox_checkpoints" (
	"source_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"checkpoint" timestamp with time zone,
	"health" varchar(20) DEFAULT 'ok' NOT NULL,
	"last_error" text,
	"last_polled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "media_objects" (
	"key" varchar(512) PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"size" integer NOT NULL,
	"draft_id" uuid,
	"confirmed_at" timestamp with time zone,
	"delete_after" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"draft_id" uuid,
	"draft_version" integer,
	"type" varchar(50) NOT NULL,
	"channel" varchar(20),
	"state" varchar(20) DEFAULT 'pending' NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"idempotency_key" varchar(255),
	"source_event_id" varchar(255),
	"result" jsonb,
	"error_info" jsonb,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 5 NOT NULL,
	"lease_owner" varchar(255),
	"lease_until" timestamp with time zone,
	"correlation_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_idempotency_key_unique" UNIQUE("idempotency_key")
);

CREATE TABLE "reconciliation_state" (
	"tenant_id" uuid NOT NULL,
	"entity" varchar(30) NOT NULL,
	"checkpoint" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "reconciliation_state_pk" UNIQUE("tenant_id","entity")
);

CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" varchar(30) DEFAULT 'digest' NOT NULL,
	"local_date" varchar(10) NOT NULL,
	"next_run_utc" timestamp with time zone NOT NULL,
	"timezone" varchar(63) NOT NULL,
	"digest_type" varchar(20) DEFAULT 'morning' NOT NULL,
	"state" varchar(20) DEFAULT 'pending' NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" varchar(255),
	"completed_at" timestamp with time zone,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"error_info" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_idempotency_key_unique" UNIQUE("idempotency_key")
);

CREATE TABLE "stage_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"opportunity_id" varchar(255) NOT NULL,
	"from_stage_id" varchar(100),
	"to_stage_id" varchar(100) NOT NULL,
	"terminal_type" varchar(10),
	"changed_at" timestamp with time zone NOT NULL,
	"source" varchar(20) NOT NULL,
	"amount_micros" bigint,
	"currency" varchar(3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(63) NOT NULL,
	"name" varchar(255) NOT NULL,
	"deployment_id" varchar(63) DEFAULT 'shared_01' NOT NULL,
	"twenty_workspace_id" varchar(255) NOT NULL,
	"twenty_base_url" varchar(512),
	"twenty_api_token_ref" varchar(512) NOT NULL,
	"timezone" varchar(63) DEFAULT 'UTC' NOT NULL,
	"working_days" jsonb DEFAULT '[1,2,3,4,5]'::jsonb NOT NULL,
	"morning_reminder_time" varchar(5) DEFAULT '09:00' NOT NULL,
	"default_currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"pipeline_config" jsonb,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"quota_limits" jsonb,
	"retention_policy" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);

CREATE TABLE "usage_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "usage_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"kind" varchar(30) NOT NULL,
	"quantity" bigint NOT NULL,
	"provider" varchar(50),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"twenty_member_id" varchar(255),
	"display_name" varchar(255) NOT NULL,
	"email" varchar(255),
	"role" varchar(20) NOT NULL,
	"team_id" varchar(255),
	"managed_team_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preferred_reminder_channel" varchar(20),
	"dual_delivery" boolean DEFAULT false NOT NULL,
	"user_timezone" varchar(63),
	"user_morning_time" varchar(5),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "channel_bindings" ADD CONSTRAINT "channel_bindings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "channel_bindings" ADD CONSTRAINT "channel_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "intake_records" ADD CONSTRAINT "intake_records_source_id_intake_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."intake_sources"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "intake_sources" ADD CONSTRAINT "intake_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "mailbox_checkpoints" ADD CONSTRAINT "mailbox_checkpoints_source_id_intake_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."intake_sources"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
CREATE INDEX "audit_tenant_time_idx" ON "audit_log" USING btree ("tenant_id","timestamp");
CREATE INDEX "audit_correlation_idx" ON "audit_log" USING btree ("correlation_id");
CREATE INDEX "channel_bindings_tenant_idx" ON "channel_bindings" USING btree ("tenant_id");
CREATE INDEX "channel_bindings_lookup_idx" ON "channel_bindings" USING btree ("channel","connection_id","external_id");
CREATE INDEX "channel_bindings_user_idx" ON "channel_bindings" USING btree ("user_id");
CREATE INDEX "dead_letters_open_idx" ON "dead_letters" USING btree ("resolved_at","created_at");
CREATE INDEX "delivery_tenant_status_idx" ON "delivery_state" USING btree ("tenant_id","status");
CREATE INDEX "delivery_external_msg_idx" ON "delivery_state" USING btree ("external_message_id");
CREATE INDEX "drafts_tenant_user_idx" ON "drafts" USING btree ("tenant_id","user_id");
CREATE INDEX "drafts_conversation_idx" ON "drafts" USING btree ("conversation_id","state");
CREATE INDEX "drafts_expiry_idx" ON "drafts" USING btree ("expires_at") WHERE state in ('collecting','awaiting_confirmation');
CREATE INDEX "enrollments_tenant_idx" ON "enrollments" USING btree ("tenant_id");
CREATE INDEX "idempotency_expiry_idx" ON "idempotency_keys" USING btree ("expires_at");
CREATE INDEX "inbound_events_created_idx" ON "inbound_events" USING btree ("created_at");
CREATE INDEX "intake_tenant_state_idx" ON "intake_records" USING btree ("tenant_id","state");
CREATE INDEX "intake_submission_idx" ON "intake_records" USING btree ("source_id","submission_id");
CREATE INDEX "intake_message_idx" ON "intake_records" USING btree ("source_id","message_id");
CREATE INDEX "intake_fingerprint_idx" ON "intake_records" USING btree ("source_id","content_fingerprint","created_at");
CREATE INDEX "media_cleanup_idx" ON "media_objects" USING btree ("deleted_at","delete_after");
CREATE INDEX "operations_tenant_idx" ON "operations" USING btree ("tenant_id","created_at");
CREATE INDEX "operations_state_idx" ON "operations" USING btree ("state","lease_until");
CREATE INDEX "schedules_pending_run_idx" ON "schedules" USING btree ("state","next_run_utc");
CREATE INDEX "schedules_tenant_user_date_idx" ON "schedules" USING btree ("tenant_id","user_id","local_date");
CREATE INDEX "stage_history_opp_idx" ON "stage_history" USING btree ("tenant_id","opportunity_id","changed_at");
CREATE UNIQUE INDEX "stage_history_dedup" ON "stage_history" USING btree ("tenant_id","opportunity_id","to_stage_id","changed_at");
CREATE INDEX "usage_tenant_kind_idx" ON "usage_events" USING btree ("tenant_id","kind","occurred_at");
CREATE INDEX "users_tenant_idx" ON "users" USING btree ("tenant_id");
CREATE INDEX "users_status_idx" ON "users" USING btree ("tenant_id","status");
CREATE UNIQUE INDEX "users_member_uq" ON "users" USING btree ("tenant_id","twenty_member_id") WHERE twenty_member_id is not null;