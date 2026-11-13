# Wallet ledger: migration SQL and service contract

`schema/wallet.ts` defines the wallet accounts, transaction headers, immutable
entries, and wallet outbox. Root should export these tables from
`src/database/schema/index.ts`, generate/review the Drizzle migration, and
append the trigger SQL below to that migration. Do not apply this SQL to a
shared or production database as part of feature development.

## Required PostgreSQL triggers

The Drizzle schema supplies columns, foreign keys, ordinary constraints and
indexes. These triggers enforce append-only ledger history, currency matching,
projection updates from entries, and deferred double-entry balance at commit.
Values are integer minor units. The unconstrained `numeric` columns are guarded
at 38 digits so PostgreSQL rejects fractional values instead of rounding them.

```sql
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
```

The projection trigger executes on every inserted entry in the same database
transaction as the journal. `posted_at` is set exactly once after entries and
the outbox event exist; later entry/outbox insertion is rejected. The deferred
commit check requires the final marker, a balanced journal, and its outbox
event. A wallet account's check constraint rejects a negative balance; system
accounts are permitted to go negative. The service locks both accounts in UUID
order before posting so concurrent transfers that touch the same accounts use
a stable lock order. The projection guard checks trigger nesting, so a custom
`SET LOCAL` value cannot authorize a direct balance update. Balance
reconciliation can compare each projection against `sum(credits) -
sum(debits)` from `ledger_entries`; never repair a mismatch with an unreviewed
direct update.

## Service contract

`WalletService.postTransfer(input, client?)` is the only supported posting
primitive. `debitAccountId` is reduced and `creditAccountId` is increased by the
same positive `amountMinor`. Amounts are decimal integer strings, capped at 38
digits; no money value is converted to JavaScript `number`.

- `idempotencyScope` + `idempotencyKey` identify a request. Canonically hashed
  input includes currency, amount, accounts, reference, actor, reason and safe
  metadata. Replaying identical input returns the original transaction;
  reusing the key with different input returns `409`.
- A non-null `(referenceNamespace, referenceId)` is globally unique. Posting a
  second transaction with the same reference returns `409`.
- The supplied `PoolClient` keeps transaction ownership with the caller. The
  service uses a savepoint and never commits or rolls back that outer
  transaction, so checkout can compose wallet debit with order/reservation
  writes atomically. Without a client the service owns BEGIN/COMMIT/ROLLBACK.
- User wallet accounts are unique per user and currency. System accounts are
  unique per system key and currency. A system clearing account is required
  for provider-side credits; wallet accounts cannot be overdrawn.
- Each transaction stores actor type/id, reason, safe metadata, request hash,
  and reference. Posting also writes a minimal `ledger.transfer.posted` outbox
  record in the same transaction; it contains only transaction ID and currency.
- `GET /api/v1/me/wallet` and `GET /api/v1/me/wallet/transactions` are authenticated,
  user-scoped reads, with IDR as the pilot wallet currency. A read does not
  create an account; an existing user with no IDR account sees a zero balance,
  while an unknown user is rejected. Cursor paging is bounded to 100 records.
  There is no HTTP route for arbitrary credits/debits; providers and domain
  services use the internal transfer primitive after their own validation.

This module does not choose platform fees, commissions, taxes, payable timing,
settlement, refund policy, or payout rules. It supplies balanced posting and
wallet views for later domain workflows.
