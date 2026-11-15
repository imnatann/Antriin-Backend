CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"purpose" varchar(32) NOT NULL,
	"storage_key" varchar(200) NOT NULL,
	"content_type" varchar(64) NOT NULL,
	"byte_size" integer NOT NULL,
	"checksum_sha256" varchar(64) NOT NULL,
	"original_filename" varchar(255) DEFAULT '' NOT NULL,
	"width" integer,
	"height" integer,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_purpose_check" CHECK ("media_assets"."purpose" in ('menu_item', 'tenant_logo', 'tenant_cover', 'avatar', 'case_evidence')),
	CONSTRAINT "media_assets_content_type_check" CHECK ("media_assets"."content_type" in ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "media_assets_byte_size_check" CHECK ("media_assets"."byte_size" > 0 and "media_assets"."byte_size" <= 20971520),
	CONSTRAINT "media_assets_checksum_check" CHECK ("media_assets"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "media_assets_dimensions_check" CHECK (("media_assets"."width" is null and "media_assets"."height" is null) or (coalesce("media_assets"."width", 0) > 0 and coalesce("media_assets"."height", 0) > 0))
);
--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_storage_key_unique" ON "media_assets" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "media_assets_owner_created_idx" ON "media_assets" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "media_assets_purpose_created_idx" ON "media_assets" USING btree ("purpose","created_at");