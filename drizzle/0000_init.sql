CREATE TYPE "public"."friendship_status" AS ENUM('pending', 'accepted');--> statement-breakpoint
CREATE TYPE "public"."penalty" AS ENUM('none', 'plus2', 'dnf');--> statement-breakpoint
CREATE TYPE "public"."race_mode" AS ENUM('quick', 'private', 'tournament');--> statement-breakpoint
CREATE TYPE "public"."race_result" AS ENUM('win', 'loss', 'dnf', 'left');--> statement-breakpoint
CREATE TYPE "public"."race_status" AS ENUM('waiting', 'countdown', 'racing', 'settled');--> statement-breakpoint
CREATE TYPE "public"."scramble_source" AS ENUM('random', 'wca', 'reused');--> statement-breakpoint
CREATE TYPE "public"."tournament_format" AS ENUM('single', 'double', 'swiss');--> statement-breakpoint
CREATE TYPE "public"."tournament_scope" AS ENUM('global', 'country');--> statement-breakpoint
CREATE TYPE "public"."tournament_status" AS ENUM('scheduled', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"country" char(2),
	"elo" integer DEFAULT 1000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "solves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event" text NOT NULL,
	"scramble" text NOT NULL,
	"scramble_source" "scramble_source" NOT NULL,
	"time_ms" integer NOT NULL,
	"penalty" "penalty" DEFAULT 'none' NOT NULL,
	"solved_at" timestamp with time zone NOT NULL,
	"move_count" integer,
	"solved_count" integer,
	"attempted_count" integer,
	"client_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "race_participants" (
	"race_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"time_ms" integer,
	"penalty" "penalty" DEFAULT 'none' NOT NULL,
	"ready" boolean DEFAULT false NOT NULL,
	"result" "race_result",
	"finished_at" timestamp with time zone,
	CONSTRAINT "race_participants_race_id_user_id_pk" PRIMARY KEY("race_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "races" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event" text NOT NULL,
	"scramble" text NOT NULL,
	"mode" "race_mode" NOT NULL,
	"status" "race_status" DEFAULT 'waiting' NOT NULL,
	"code" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "friendships" (
	"user_id" uuid NOT NULL,
	"friend_id" uuid NOT NULL,
	"status" "friendship_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "friendships_user_id_friend_id_pk" PRIMARY KEY("user_id","friend_id"),
	CONSTRAINT "friendships_no_self" CHECK ("friendships"."user_id" <> "friendships"."friend_id")
);
--> statement-breakpoint
CREATE TABLE "tournament_entries" (
	"tournament_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"best_time_ms" integer,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournament_entries_tournament_id_user_id_pk" PRIMARY KEY("tournament_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "tournaments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"format" "tournament_format" NOT NULL,
	"event" text NOT NULL,
	"scope" "tournament_scope" DEFAULT 'global' NOT NULL,
	"country" char(2),
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "tournament_status" DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "solves" ADD CONSTRAINT "solves_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_participants" ADD CONSTRAINT "race_participants_race_id_races_id_fk" FOREIGN KEY ("race_id") REFERENCES "public"."races"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_participants" ADD CONSTRAINT "race_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "races" ADD CONSTRAINT "races_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_friend_id_users_id_fk" FOREIGN KEY ("friend_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "solves_user_event_solved_at_idx" ON "solves" USING btree ("user_id","event","solved_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "solves_user_client_id_key" ON "solves" USING btree ("user_id","client_id");--> statement-breakpoint
CREATE INDEX "solves_user_updated_at_idx" ON "solves" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "solves_event_time_idx" ON "solves" USING btree ("event","time_ms") WHERE "solves"."deleted" = false and "solves"."penalty" <> 'dnf';--> statement-breakpoint
CREATE INDEX "race_participants_user_idx" ON "race_participants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "races_active_code_key" ON "races" USING btree ("code") WHERE "races"."code" is not null and "races"."status" <> 'settled';--> statement-breakpoint
CREATE INDEX "races_status_event_idx" ON "races" USING btree ("status","event");--> statement-breakpoint
CREATE INDEX "races_created_by_created_at_idx" ON "races" USING btree ("created_by","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "friendships_friend_idx" ON "friendships" USING btree ("friend_id");--> statement-breakpoint
CREATE INDEX "tournament_entries_user_idx" ON "tournament_entries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tournament_entries_leaderboard_idx" ON "tournament_entries" USING btree ("tournament_id","best_time_ms");--> statement-breakpoint
CREATE INDEX "tournaments_status_starts_at_idx" ON "tournaments" USING btree ("status","starts_at");