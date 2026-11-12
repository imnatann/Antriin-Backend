CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"direction" varchar(8) NOT NULL,
	"amount_minor" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_direction_check" CHECK ("ledger_entries"."direction" in ('debit', 'credit')),
	CONSTRAINT "ledger_entries_amount_positive_check" CHECK ("ledger_entries"."amount_minor" > 0),
	CONSTRAINT "ledger_entries_amount_integer_precision_check" CHECK ("ledger_entries"."amount_minor" = trunc("ledger_entries"."amount_minor") and "ledger_entries"."amount_minor" < 1e38)
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"currency" varchar(3) NOT NULL,
	"idempotency_scope" varchar(120) NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"actor_type" varchar(16) NOT NULL,
	"actor_id" varchar(200) NOT NULL,
	"reason" varchar(500) NOT NULL,
	"reference_namespace" varchar(120),
	"reference_id" varchar(200),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_transactions_currency_check" CHECK ("ledger_transactions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "ledger_transactions_actor_type_check" CHECK ("ledger_transactions"."actor_type" in ('user', 'service')),
	CONSTRAINT "ledger_transactions_reference_pair_check" CHECK (("ledger_transactions"."reference_namespace" is null and "ledger_transactions"."reference_id" is null) or ("ledger_transactions"."reference_namespace" is not null and "ledger_transactions"."reference_id" is not null)),
	CONSTRAINT "ledger_transactions_request_hash_check" CHECK ("ledger_transactions"."request_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "wallet_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_type" varchar(16) NOT NULL,
	"owner_user_id" uuid,
	"system_key" varchar(120),
	"currency" varchar(3) NOT NULL,
	"balance_minor" numeric DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_accounts_type_owner_check" CHECK (("wallet_accounts"."account_type" = 'wallet' and "wallet_accounts"."owner_user_id" is not null and "wallet_accounts"."system_key" is null) or ("wallet_accounts"."account_type" = 'system' and "wallet_accounts"."owner_user_id" is null and "wallet_accounts"."system_key" is not null)),
	CONSTRAINT "wallet_accounts_currency_check" CHECK ("wallet_accounts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "wallet_accounts_balance_nonnegative_check" CHECK ("wallet_accounts"."account_type" = 'system' or "wallet_accounts"."balance_minor" >= 0),
	CONSTRAINT "wallet_accounts_balance_integer_precision_check" CHECK ("wallet_accounts"."balance_minor" = trunc("wallet_accounts"."balance_minor") and abs("wallet_accounts"."balance_minor") < 1e38),
	CONSTRAINT "wallet_accounts_system_key_check" CHECK ("wallet_accounts"."system_key" is null or length(trim("wallet_accounts"."system_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "wallet_outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" varchar(120) NOT NULL,
	"aggregate_type" varchar(80) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "wallet_outbox_attempts_nonnegative_check" CHECK ("wallet_outbox_events"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."wallet_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_owner_user_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_outbox_events" ADD CONSTRAINT "wallet_outbox_transaction_fk" FOREIGN KEY ("aggregate_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_transaction_account_uq" ON "ledger_entries" USING btree ("transaction_id","account_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_transaction_idx" ON "ledger_entries" USING btree ("account_id","transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transactions_idempotency_uq" ON "ledger_transactions" USING btree ("idempotency_scope","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transactions_reference_uq" ON "ledger_transactions" USING btree ("reference_namespace","reference_id") WHERE "ledger_transactions"."reference_id" is not null;--> statement-breakpoint
CREATE INDEX "ledger_transactions_created_idx" ON "ledger_transactions" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_accounts_owner_currency_uq" ON "wallet_accounts" USING btree ("owner_user_id","currency") WHERE "wallet_accounts"."owner_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_accounts_system_currency_uq" ON "wallet_accounts" USING btree ("system_key","currency") WHERE "wallet_accounts"."system_key" is not null;--> statement-breakpoint
CREATE INDEX "wallet_accounts_owner_idx" ON "wallet_accounts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_outbox_event_aggregate_uq" ON "wallet_outbox_events" USING btree ("event_type","aggregate_type","aggregate_id");--> statement-breakpoint
CREATE INDEX "wallet_outbox_unpublished_idx" ON "wallet_outbox_events" USING btree ("occurred_at","id") WHERE "wallet_outbox_events"."published_at" is null;
--> statement-breakpoint
create or replace function antriin_wallet_guard_account_update()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.balance_minor <> 0 then
      raise exception 'wallet accounts must start at zero' using errcode = '55000';
    end if;
    return new;
  end if;
  if new.account_type is distinct from old.account_type
     or new.owner_user_id is distinct from old.owner_user_id
     or new.system_key is distinct from old.system_key
     or new.currency is distinct from old.currency
     or new.created_at is distinct from old.created_at then
    raise exception 'wallet account identity is immutable' using errcode = '55000';
  end if;
  if new.balance_minor is distinct from old.balance_minor
     and pg_trigger_depth() < 2 then
    raise exception 'wallet balance is a ledger projection' using errcode = '55000';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger wallet_accounts_guard_update
before insert or update on wallet_accounts
for each row execute function antriin_wallet_guard_account_update();

create or replace function antriin_wallet_accounts_no_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'wallet accounts are retained' using errcode = '55000';
end;
$$;

create trigger wallet_accounts_no_delete
before delete on wallet_accounts
for each row execute function antriin_wallet_accounts_no_delete();

create trigger wallet_accounts_no_truncate
before truncate on wallet_accounts
for each statement execute function antriin_wallet_accounts_no_delete();

create or replace function antriin_wallet_entries_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'ledger entries are immutable' using errcode = '55000';
end;
$$;

create trigger ledger_entries_no_update_delete
before update or delete on ledger_entries
for each row execute function antriin_wallet_entries_append_only();

create trigger ledger_entries_no_truncate
before truncate on ledger_entries
for each statement execute function antriin_wallet_entries_append_only();

create or replace function antriin_wallet_ledger_no_truncate()
returns trigger language plpgsql as $$
begin
  raise exception 'ledger history cannot be truncated' using errcode = '55000';
end;
$$;

create or replace function antriin_wallet_entry_requires_open_transaction()
returns trigger language plpgsql as $$
declare
  transaction_posted_at timestamptz;
begin
  select posted_at into strict transaction_posted_at
    from ledger_transactions where id = new.transaction_id;
  if transaction_posted_at is not null then
    raise exception 'cannot append entries to a posted ledger transaction'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger ledger_entries_require_open_transaction
before insert on ledger_entries
for each row execute function antriin_wallet_entry_requires_open_transaction();

create or replace function antriin_wallet_transactions_append_only()
returns trigger language plpgsql as $$
begin
  if old.posted_at is not null
     or new.posted_at is null
     or (to_jsonb(new) - 'posted_at') is distinct from (to_jsonb(old) - 'posted_at') then
    raise exception 'ledger transaction is immutable except for one-time posting'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger ledger_transactions_no_update_delete
before update or delete on ledger_transactions
for each row execute function antriin_wallet_transactions_append_only();

create trigger ledger_transactions_no_truncate
before truncate on ledger_transactions
for each statement execute function antriin_wallet_ledger_no_truncate();

create or replace function antriin_wallet_outbox_requires_open_transaction()
returns trigger language plpgsql as $$
declare
  transaction_posted_at timestamptz;
begin
  select posted_at into strict transaction_posted_at
    from ledger_transactions where id = new.aggregate_id;
  if transaction_posted_at is not null then
    raise exception 'cannot append outbox events to a posted ledger transaction'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger wallet_outbox_requires_open_transaction
before insert on wallet_outbox_events
for each row execute function antriin_wallet_outbox_requires_open_transaction();

create or replace function antriin_wallet_apply_entry_projection()
returns trigger language plpgsql as $$
declare
  transaction_currency varchar(3);
  account_currency varchar(3);
  account_type_value varchar(16);
  delta numeric;
begin
  select currency into strict transaction_currency
    from ledger_transactions where id = new.transaction_id;
  select currency, account_type into strict account_currency, account_type_value
    from wallet_accounts where id = new.account_id for update;
  if transaction_currency <> account_currency then
    raise exception 'ledger entry currency mismatch' using errcode = '23514';
  end if;
  delta := case new.direction when 'credit' then new.amount_minor else -new.amount_minor end;
  update wallet_accounts
     set balance_minor = balance_minor + delta, updated_at = now()
   where id = new.account_id;
  return new;
end;
$$;

create trigger ledger_entries_apply_projection
after insert on ledger_entries
for each row execute function antriin_wallet_apply_entry_projection();

create or replace function antriin_wallet_assert_transaction_balanced()
returns trigger language plpgsql as $$
declare
  entry_count bigint;
  debit_total numeric;
  credit_total numeric;
  transaction_posted_at timestamptz;
begin
  select posted_at into strict transaction_posted_at
    from ledger_transactions where id = new.id;
  select count(*),
         coalesce(sum(amount_minor) filter (where direction = 'debit'), 0),
         coalesce(sum(amount_minor) filter (where direction = 'credit'), 0)
    into entry_count, debit_total, credit_total
    from ledger_entries where transaction_id = new.id;
  if transaction_posted_at is null or entry_count < 2 or debit_total <> credit_total then
    raise exception 'ledger transaction must have balanced debit and credit entries'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from wallet_outbox_events
     where event_type = 'ledger.transfer.posted'
       and aggregate_type = 'ledger_transaction'
       and aggregate_id = new.id
  ) then
    raise exception 'ledger transaction requires its outbox event' using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger ledger_transactions_balanced_at_commit
after insert on ledger_transactions
deferrable initially deferred
for each row execute function antriin_wallet_assert_transaction_balanced();

create or replace function antriin_wallet_outbox_payload_immutable()
returns trigger language plpgsql as $$
begin
  if new.id is distinct from old.id
     or new.event_type is distinct from old.event_type
     or new.aggregate_type is distinct from old.aggregate_type
     or new.aggregate_id is distinct from old.aggregate_id
     or new.payload is distinct from old.payload
     or new.occurred_at is distinct from old.occurred_at then
    raise exception 'wallet outbox event identity is immutable' using errcode = '55000';
  end if;
  if old.published_at is not null and new.published_at is distinct from old.published_at then
    raise exception 'published wallet outbox event cannot be reopened' using errcode = '55000';
  end if;
  if new.attempts < old.attempts then
    raise exception 'wallet outbox attempts cannot decrease' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger wallet_outbox_guard_update
before update on wallet_outbox_events
for each row execute function antriin_wallet_outbox_payload_immutable();

create or replace function antriin_wallet_outbox_no_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'wallet outbox events are immutable' using errcode = '55000';
end;
$$;

create trigger wallet_outbox_no_delete
before delete on wallet_outbox_events
for each row execute function antriin_wallet_outbox_no_delete();

create trigger wallet_outbox_no_truncate
before truncate on wallet_outbox_events
for each statement execute function antriin_wallet_outbox_no_delete();
