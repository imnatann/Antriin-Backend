# Implementasi Schema 0007 — Perbaikan Integritas Wave 1 (task-6)

- **Implementer:** schema-fixer (task-6, diklaim di task board; tidak ditandai complete — acceptance milik root)
- **Tanggal:** 12 November 2026
- **Basis keputusan (mengikat):** [wave1-decisions.md](wave1-decisions.md) §D12 + brief task-6 + penegasan root 12 Nov (menu_items_archived_at_check bidirectional)
- **Temuan yang diimplementasikan:** [schema-wave1.md](schema-wave1.md) — R1-01 (BLOCKER), R1-02..R1-08 (MAJOR), R1-10..R1-17 & R1-22 (MINOR disetujui)
- **Migrasi:** `drizzle/0007_yielding_rafael_vega.sql` (+ `drizzle/meta/_journal.json` idx 7, `drizzle/meta/0007_snapshot.json`)
- **Aturan yang dijaga:** ADITIF — tanpa rename, tanpa perubahan tipe, tanpa DROP kolom/tabel. Satu-satunya DROP CONSTRAINT adalah penggantian dua CHECK yang DILONGGARKAN atas keputusan eksplisit D12 (lihat §3).

---

## 1. File yang berubah

| File                                                            | Perubahan                                                                                                                                                                                                             |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/database/schema/orders.ts`                                 | +150/-2: kolom order_number/paid_at/cancelled_at/declined_at, notes, request_id, expires_at (idempotency); 2 UNIQUE composite orders, 1 UNIQUE pickup_credentials; 6 FK baru; 11 CHECK baru/diperbarui; 2 indeks baru |
| `src/database/schema/catalog.ts`                                | +69/-2: image_ref/archived_at (menu_items), consumed_at/updated_at (slot_reservations), created_at + PRIMARY KEY (2 tabel operating hours), FK slot_reservations→orders; 2 CHECK baru; komentar konvensi weekday      |
| `src/database/schema/payments.ts`                               | +24: expires_at/succeeded_at (topup_intents), FK composite user+wallet, 2 CHECK baru                                                                                                                                  |
| `src/database/schema/wallet.ts`                                 | +6: `unique('wallet_accounts_owner_id_uq').on(ownerUserId, id)` — SATU-SATUNYA perubahan file foundation, sesuai brief                                                                                                |
| `drizzle/0007_yielding_rafael_vega.sql`                         | Baru (50 statement; hasil `npm run db:generate` + reorder pernyataan, lihat §4)                                                                                                                                       |
| `drizzle/meta/_journal.json`, `drizzle/meta/0007_snapshot.json` | Baru/diupdate oleh drizzle-kit                                                                                                                                                                                        |
| `test/schema-integrity.spec.ts`                                 | Baru: 15 test node:test yang mencoba melanggar tiap aturan baru terhadap PostgreSQL nyata                                                                                                                             |

`src/database/schema/index.ts` TIDAK diubah (tidak diperlukan; semua import memakai edge yang sudah ada — config callback drizzle bersifat lazy sehingga FK lintas file catalog↔orders aman tanpa circular-import hazard).

## 2. Pemetaan keputusan → constraint (nama persis di DB)

### BLOCKER / MAJOR

| Temuan | Objek baru di 0007                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1-01  | FK `orders_tenant_slot_fk` (tenant_id, pickup_slot_id) → pickup_slots(tenant_id, id) ON DELETE RESTRICT                                                                                                                                                                                                                                                                                                                                                                                    |
| R1-02  | FK `slot_reservations_order_fk` (order_id) → orders(id) ON DELETE RESTRICT                                                                                                                                                                                                                                                                                                                                                                                                                 |
| R1-03  | UNIQUE `orders_tenant_id_id_uq` (tenant_id,id), UNIQUE `orders_buyer_id_id_uq` (buyer_id,id), UNIQUE `pickup_credentials_order_id_id_uq` (order_id,id); FK `schedule_proposals_tenant_order_fk`, `schedule_proposals_tenant_proposed_slot_fk`, `schedule_proposals_tenant_old_slot_fk`, `order_handovers_tenant_order_fk`, `order_handovers_order_credential_fk` — semua ON DELETE RESTRICT                                                                                                |
| R1-04  | UNIQUE `wallet_accounts_owner_id_uq` (owner_user_id,id) + FK `topup_intents_user_wallet_fk` (user_id, wallet_account_id) → wallet_accounts(owner_user_id, id) RESTRICT. Owner NULL (system account) tetap aman: NULL distinct, dan top-up ke wallet sistem selalu ditolak FK                                                                                                                                                                                                               |
| R1-05  | Kolom `orders.paid_at/cancelled_at/declined_at` (NULL); CHECK `orders_status_timestamps_check` (paid_awaiting_tenant → confirmed/preparing/ready/completed NULL; confirmed/preparing/ready_for_pickup → confirmed_at & paid_at terisi; completed → + ready_at & completed_at; cancelled → cancelled_at; declined → declined_at); CHECK `orders_timestamps_monotonic_check` (created ≤ confirmed ≤ preparing ≤ ready ≤ completed, hanya mengikat kolom yang terisi — NULL comparison lolos) |
| R1-06  | CHECK `schedule_proposals_expires_at_check` (expires_at > created_at); CHECK `schedule_proposals_decided_at_check` ((pending_buyer ∧ decided_at NULL) ∨ (¬pending_buyer ∧ decided_at NOT NULL))                                                                                                                                                                                                                                                                                            |
| R1-07  | CHECK `order_items_line_total_check` (line_total_minor = unit_price_minor × quantity); CHECK `orders_total_equals_subtotal_check` (total = subtotal, pilot tanpa fee/pajak — D12.1); CHECK `orders_positive_totals_check` (subtotal > 0 ∧ total > 0 — order total 0 DITOLAK, D12.5). Invariant cross-row (Σ line = subtotal; order_payments.amount = total) tetap transaksional di service + test rekonsiliasi                                                                             |
| R1-08  | Kolom `topup_intents.expires_at/succeeded_at` (NULL — aditif aman); CHECK `topup_intents_expires_at_check` (expires_at NULL ∨ expires_at > created_at); CHECK `topup_intents_succeeded_at_check` (succeeded_at NULL ∨ status='succeeded')                                                                                                                                                                                                                                                  |

### MINOR (disetujui D12)

| Temuan | Objek baru di 0007                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-10  | `orders.order_number` varchar(32) NULL + UNIQUE INDEX `orders_order_number_uq`. lihat §3 butir 1 (NULL dulu, NOT NULL menyusul)                                                                                                                                                                                                                                                                                                                                 |
| R1-11  | `menu_items.image_ref` varchar(500) NULL, `menu_items.archived_at` timestamptz NULL, CHECK `menu_items_archived_at_check` BIDIRECTIONAL sesuai penegasan root: (status='archived' ∧ archived_at NOT NULL) ∨ (status≠'archived' ∧ archived_at NULL) — reaktivasi item wajib menghapus archived_at                                                                                                                                                                |
| R1-12  | `order_items.notes` varchar(500) NOT NULL DEFAULT ''                                                                                                                                                                                                                                                                                                                                                                                                            |
| R1-13  | `slot_reservations.consumed_at` NULL, `slot_reservations.updated_at` NOT NULL DEFAULT now() (di-set eksplisit oleh aplikasi), CHECK `slot_reservations_consumed_at_check` dua arah (pola released_at)                                                                                                                                                                                                                                                           |
| R1-14  | CHECK `pickup_credentials_expires_at_check` (expires_at > created_at), CHECK `pickup_credentials_consume_revoke_check` (consumed_at NULL ∨ revoked_at NULL). Attempt counter tetap app-level (D12)                                                                                                                                                                                                                                                              |
| R1-15  | CHECK `order_events_type_check` diperluas 4 → 8 nilai: order.created, order.status_changed, order.cancelled, order.declined, schedule_proposal.created, schedule_proposal.decided, pickup_credential.issued, pickup_credential.revoked; kolom `order_events.request_id` uuid NULL + FK `order_events_request_fk` → order_request_idempotency(id) RESTRICT + INDEX `order_events_order_request_idx` (order_id, request_id)                                       |
| R1-16  | `order_request_idempotency.expires_at` timestamptz NULL + INDEX parsial `order_request_idempotency_expires_idx` (expires_at) WHERE expires_at IS NOT NULL untuk job cleanup (job = wave operasional)                                                                                                                                                                                                                                                            |
| R1-17  | PRIMARY KEY CONSTRAINT `tenant_operating_hours_pk` (tenant_id, weekday) dan `tenant_operating_hour_overrides_pk` (tenant_id, local_date); `created_at` timestamptz NOT NULL DEFAULT now() di keduanya; konvensi weekday 0=Minggu..6=Sabtu (JS Date.getDay(), timezone tenant/kampus) ditulis sebagai komentar schema di catalog.ts. Unique index lama DIPERTAHANKAN (aditif) — duplikat kini bisa dilaporkan PG dengan nama PK baru atau nama unique index lama |
| R1-22  | CHECK `order_items_quantity_check` dilonggarkan 1..99 → 1..999 (batas operasional pilot 1..200 di DTO — D12)                                                                                                                                                                                                                                                                                                                                                    |

Tidak dikerjakan (keputusan sadar D12): R1-09 campus_id (derived by join tenants.campus_id), R1-18 reserved_count (atomic update + test di slice availability), R1-19 (kebijakan service), R1-21 (succeeded-only dipertahankan), slot_reservations.expires_at (D12.6: tidak ada hold expiry di pilot). Indeks orders(tenant_id, status, pickup_starts_at) sudah ada sejak 0006 (`orders_tenant_status_pickup_idx`) — tidak diduplikasi.

## 3. Deviasi yang didokumentasikan & keputusan interpretasi

1. **order_number NULL (bukan NOT NULL).** D12.4 menulis "varchar 32, NOT NULL, UNIQUE"; brief task-6 (instruksi root terbaru) memerintahkan NULL dulu + unique index, NOT NULL di migrasi berikutnya setelah wave 2 mengisi (generator collision-safe). Diikuti: brief + aturan aditif D12 ("kolom baru wajib nullable atau punya default aman" — NOT NULL tanpa default akan gagal pada tabel berisi baris). Multiple NULL di unique index diizinkan PG (NULLS DISTINCT).
2. **Dua DROP CONSTRAINT — satu-satunya pengecualian aturan aditif**, keduanya PELONGGARAN yang diperintahkan eksplisit D12: `order_events_type_check` (4→8 nilai, R1-15/D12.7) dan `order_items_quantity_check` (99→999, R1-22). Tidak mungkin mengganti CHECK tanpa drop+add; aman untuk data existing karena aturan baru lebih longgar.
3. **CHECK dua arah vs satu arah.** Dua arah (status↔timestamp) untuk orders/schedule_proposals/slot_reservations.consumed_at/menu_items.archived_at: tabel-tabel ini belum punya penulis produksi (wave 2 belum ada; katalog archive mengisi archived_at per penegasan root). Satu arah (hanya "bila terisi") untuk topup_intents.succeeded_at/expires_at: payments-impl SEDANG menulis kode terhadap 0006 — sesuai brief, CHECK hanya mengikat data baru.
4. **Konvensi penamaan** mengikuti pola repo: `<table>_<makna>_fk/_check/_uq`; PRIMARY KEY diberi nama eksplisit `<table>_pk`.

## 4. Bug urutan statement drizzle-kit (ditemukan, diperbaiki, terbukti)

`drizzle-kit generate` (v0.31.11) menghasilkan 0007 dengan ADD CONSTRAINT FOREIGN KEY composite SEBELUM ADD CONSTRAINT UNIQUE targetnya. PostgreSQL menolak FK yang target unique-nya belum ada. Bukti kegagalan nyata (replikasi manual psql -v ON_ERROR_STOP=1, DB fresh 0000..0006 + 0007 hasil generate apa adanya):

```
ERROR:  there is no unique constraint matching given keys for referenced table "orders"
```

(Ini pola kegagalan yang sama dengan draft 0006_dear_sasquatch di D1. `npm run db:migrate` sendiri menelan pesan errornya — hanya spinner lalu exit 1; replikasi psql per file yang mengungkap statement gagal, persis skenario yang diantisipasi brief.)

**Perbaikan:** statement di `0007_yielding_rafael_vega.sql` diurutkan ulang menjadi: 2 DROP CONSTRAINT → 2 ADD PRIMARY KEY → 4 ADD UNIQUE → 15 ADD COLUMN → 9 ADD FOREIGN KEY → 3 CREATE INDEX → 15 ADD CHECK. Verifikasi: multiset statement identik (permutasi murni, 50 statement, dicek programatik); snapshot/journal tidak tersentuh oleh reorder; `npm run db:generate` ulang melaporkan **"No schema changes, nothing to migrate"** (schema TS ≡ snapshot ≡ tidak akan ada diff liar di generate berikutnya).

## 5. Bukti eksekusi (semua dijalankan 12 Nov 2026, Node v24.22.2, PostgreSQL 17-alpine container antriin-swarm-pg @127.0.0.1:5544)

### 5.1 Apply bersih di DB kosong

```
docker exec antriin-swarm-pg psql -U antriin_swarm -d postgres -c "CREATE DATABASE antriin_schema0007"
DATABASE_URL=postgresql://antriin_swarm:swarm_local_only@127.0.0.1:5544/antriin_schema0007 npm run db:migrate
→ exit code 0
→ migrations_applied=8 (0000..0007), public_tables=39, fk_total=63 (54 + 9 baru), check_total=111
```

### 5.2 Apply pada DB BERISI DATA (syarat brief: migrasi tidak boleh gagal pada DB dengan data)

DB kedua `antriin_schema0007_data`: 0000..0006 via psql ON_ERROR_STOP=1, seed data valid era-0006 (1 campus, 1 tenant, 2 user, 1 wallet (balance 0 — guard trigger ledger menolak saldo awal ≠ 0), 1 slot (reserved_count=1), 1 order paid_awaiting_tenant 15000/15000, 1 order_item (3×5000=15000), 1 reservation reserved, 1 kategori+item menu active, 1 operating hour + 1 override, 1 topup pending milik user itu, 1 order_event order.created, 1 credential expires+2h), lalu:

```
psql -v ON_ERROR_STOP=1 < drizzle/0007_yielding_rafael_vega.sql → 47 ALTER TABLE + 3 CREATE INDEX, exit 0
post-check: orders_still=1 reservations_still=1 fk_total=63 check_total=111   (data utuh)
```

DB proof sudah di-drop setelah verifikasi. CATATAN: baris yang TIDAK konsisten dengan aturan baru (mis. slot_reservations consumed tanpa consumed_at, atau order_id dangling) memang akan menggagalkan ADD CONSTRAINT — itu disengaja; lihat §7 dampak slice.

### 5.3 Test integritas schema (baru) — 15/15 lulus

`test/schema-integrity.spec.ts`: tiap aturan baru DICOBA dilanggar terhadap PostgreSQL dan assertion memakai SQLSTATE + nama constraint persis (bukan sekadar "error"), plus kontrol positif.

```
npx tsc -p tsconfig.test.json --outDir .test-dist-schema0007   → exit 0, tanpa error di file milik saya
TEST_DATABASE_URL=...antriin_schema0007 node --test .test-dist-schema0007/test/schema-integrity.spec.js
→ tests 15, pass 15, fail 0, skipped 0
```

Cakupan (minimal brief ✅ semua): order slot lintas tenant → 23503 orders_tenant_slot_fk (juga slot fiktif + delete order ter-reserve → RESTRICT); reservation order fiktif → 23503 slot_reservations_order_fk; proposal lintas tenant → 23503 schedule_proposals_tenant_order_fk (+ slot proposal lintas tenant → tenant_proposed_slot_fk); handover tenant lain → tenant_order_fk, credential order lain → order_credential_fk (+ kontrol handover valid); topup wallet user lain → 23503 topup_intents_user_wallet_fk (+ wallet sistem); line_total ≠ unit×qty → 23514 order_items_line_total_check; total ≠ subtotal → orders_total_equals_subtotal_check; total 0 → orders_positive_totals_check; proposal decided tanpa decided_at (+ pending dengan decided_at) → schedule_proposals_decided_at_check; expires ≤ created → schedule_proposals_expires_at_check / topup_intents_expires_at_check / pickup_credentials_expires_at_check; consumed+revoked bersamaan → pickup_credentials_consume_revoke_check; event_type tak dikenal → order_events_type_check (+ 8 nilai baru diterima, request_id fiktif → 23503 order_events_request_fk + RESTRICT delete); operating hours duplikat (tenant,weekday) & override duplikat (tenant,local_date) → 23505 (PK baru terverifikasi contype='p'; nama error bisa PK atau unique index lama — keduanya di-assert); status↔timestamp orders (5 pelanggaran + kontrol completed valid + monotonicity preparing<confirmed ditolak); archived_at bidirectional (archived tanpa ts, active dengan ts, reaktivasi tanpa clear → ditolak; archived+ts → diterima); consumed_at reservation dua arah + regresi released_at_check 0006; quantity 999 diterima / 1000 ditolak; notes default ''; order_number NULL ganda diterima / duplikat non-NULL → 23505 orders_order_number_uq; struktur pg_constraint/pg_indexes/information_schema untuk 30 constraint + 3 indeks + 15 kolom baru.

### 5.4 Regresi baseline terhadap DB termigrasi 0007 — 40/40 lulus

```
DATABASE_URL=TEST_DATABASE_URL=...antriin_schema0007 REDIS_HOST=127.0.0.1 REDIS_PORT=6381 TEST_REDIS_PORT=6381 CORS_ORIGINS=http://localhost:3001 NODE_ENV=test \
node --test .test-dist-schema0007/test/wallet-ledger.spec.js .test-dist-schema0007/test/access.service.spec.js \
  .test-dist-schema0007/test/outbox.spec.js .test-dist-schema0007/test/auth.spec.js .test-dist-schema0007/test/schema-integrity.spec.js
→ tests 40, pass 40, fail 0, skipped 0
  (wallet-ledger ✔ — termasuk setelah wallet_accounts_owner_id_uq; access.service ✔; outbox ✔; auth ✔; schema-integrity ✔ 15)
```

25 test = baseline DB-backed yang diterima (checkpoint 44/44 mencakup juga spec non-DB seperti health/api-errors/environment/auth-rate-limit/wallet-controller/access.controller yang tidak disentuh perubahan schema ini). `npm run test:integration` TIDAK saya jalankan (dilarang brief — kontainer bersama); re-run 44 penuh ada di root setelah commit.

### 5.5 Bukti struktur dari pg_constraint / pg_indexes (DB antriin_schema0007)

```
FK baru (9, semua ON DELETE RESTRICT, pg_get_constraintdef):
  order_events_request_fk            (request_id) → order_request_idempotency(id)
  order_handovers_order_credential_fk (order_id, credential_id) → pickup_credentials(order_id, id)
  order_handovers_tenant_order_fk    (tenant_id, order_id) → orders(tenant_id, id)
  orders_tenant_slot_fk              (tenant_id, pickup_slot_id) → pickup_slots(tenant_id, id)
  schedule_proposals_tenant_old_slot_fk     (tenant_id, old_slot_id) → pickup_slots(tenant_id, id)
  schedule_proposals_tenant_order_fk        (tenant_id, order_id) → orders(tenant_id, id)
  schedule_proposals_tenant_proposed_slot_fk(tenant_id, proposed_slot_id) → pickup_slots(tenant_id, id)
  slot_reservations_order_fk         (order_id) → orders(id)
  topup_intents_user_wallet_fk       (user_id, wallet_account_id) → wallet_accounts(owner_user_id, id)
UNIQUE/PK baru (6):
  orders_buyer_id_id_uq [u] UNIQUE (buyer_id, id)
  orders_tenant_id_id_uq [u] UNIQUE (tenant_id, id)
  pickup_credentials_order_id_id_uq [u] UNIQUE (order_id, id)
  wallet_accounts_owner_id_uq [u] UNIQUE (owner_user_id, id)
  tenant_operating_hours_pk [p] PRIMARY KEY (tenant_id, weekday)
  tenant_operating_hour_overrides_pk [p] PRIMARY KEY (tenant_id, local_date)
CHECK baru/diperbarui (15) — definisi terverifikasi via pg_get_constraintdef, antara lain:
  order_items_line_total_check  (line_total_minor = (unit_price_minor * (quantity)::numeric))
  order_items_quantity_check    ((quantity >= 1) AND (quantity <= 999))
  orders_total_equals_subtotal_check (total_minor = subtotal_minor)
  orders_positive_totals_check  ((subtotal_minor > 0) AND (total_minor > 0))
  orders_timestamps_monotonic_check (created<=confirmed<=preparing<=ready<=completed)
  orders_status_timestamps_check, schedule_proposals_{expires_at,decided_at}_check,
  topup_intents_{expires_at,succeeded_at}_check, menu_items_archived_at_check,
  slot_reservations_consumed_at_check, pickup_credentials_{expires_at,consume_revoke}_check,
  order_events_type_check (8 nilai)
Indeks baru (3):
  CREATE UNIQUE INDEX orders_order_number_uq ON orders (order_number)
  CREATE INDEX order_events_order_request_idx ON order_events (order_id, request_id)
  CREATE INDEX order_request_idempotency_expires_idx ON order_request_idempotency (expires_at) WHERE (expires_at IS NOT NULL)
Total DB: 39 tabel, 63 FK, 56 UNIQUE constraint, 111 CHECK.
```

### 5.6 Lint / format / typecheck

```
npm run typecheck 2>&1 | grep -E 'src/database|test/schema'  → kosong (bersih)
npx eslint src/database/schema/{orders,catalog,payments,wallet}.ts test/schema-integrity.spec.ts → exit 0
npx prettier --write (5 file yang sama) → schema files unchanged, spec terformat; eslint+tsc+40/40 test diulang setelah format → tetap hijau
git diff 0000..0006 (+ snapshot meta lama) → KOSONG (migrasi lama tidak tersentuh)
```

## 6. Status jurnal & snapshot

`_journal.json`: entry idx 7 tag `0007_yielding_rafael_vega` (when 1794469428462). `0007_snapshot.json` memuat seluruh objek baru (diverifikasi: orders.uniqueConstraints = [orders_tenant_id_id_uq, orders_buyer_id_id_uq]; 9 check orders; kolom order_number/paid_at/cancelled_at/declined_at ada). `db:generate` ulang → "No schema changes".

## 7. Dampak ke slice lain (perlu koordinasi root SEBELUM re-migrasi DB slice)

1. **availability-impl (paling mendesak).** (a) `consumeReservation` (src/modules/availability/availability.service.ts ±908) hanya `SET status='consumed'` → akan GAGAL terhadap `slot_reservations_consumed_at_check`; harus menjadi `SET status='consumed', consumed_at=now(), updated_at=now()`. (b) Fixture reserve butuh baris `orders` nyata (FK baru) dan order butuh slot tenant yang sama + total=subtotal>0. (c) **DB antriin_availability saat ini berisi 137 slot_reservations dengan order_id dangling (14 consumed)** — migrasi DB itu ke 0007 akan GAGAL di ADD CONSTRAINT sampai pemilik slice membersihkan data testnya (TRUNCATE/recreate). Saya tidak menyentuh DB slice mana pun.
2. **payments-impl.** Top-up harus memakai wallet milik user yang sama (FK composite). Kolom expires_at/succeeded_at opsional; bila diisi, CHECK mengikat. Kode berjalan tidak rusak (kolom NULL, check satu arah).
3. **catalog-impl.** Archive item wajib mengisi archived_at; reaktivasi wajib menghapusnya (CHECK bidirectional atas penegasan root). image_ref tersedia (varchar 500, opsional).
4. **tenant-campus-impl.** Error duplikat operating hours kini bisa datang dari `tenant_operating_hours_pk`/`tenant_operating_hour_overrides_pk` ATAU unique index lama — kode yang match `error.constraint` per nama harus toleran keduanya. created_at kini terisi default.
5. **wave 2 (orders/checkout/pickup).** Semua invariant §2 mengikat insert/update: paid_at wajib terisi mulai status confirmed; cancelled/declined wajib timestamp-nya; order_number harus diisi generator collision-safe (retry saat 23505) dan akan dinot-null-kan di migrasi berikutnya; event lifecycle baru tersedia (order.cancelled/declined, pickup_credential.issued/revoked) + korelasi request_id.

## 8. Risiko & pekerjaan tersisa

- **Promosi order_number NOT NULL** + generator: wave 2 + migrasi 0008 (sengaja ditunda, §3.1).
- **Cleanup job order_request_idempotency.expires_at**: wave operasional (D12; kolom + indeks parsial sudah siap).
- **Re-migrasi DB slice lain** (antriin_availability dll.) hanya boleh setelah pemilik slice membersihkan data yang tidak konsisten — di luar scope saya, sudah dilaporkan ke lead.
- **Invariant cross-row** (Σ line_total = subtotal; order_payments.amount = orders.total; reserved_count = COUNT(reservations)) tetap tanggung jawab transaksi service + test rekonsiliasi PostgreSQL (D12.1, R1-18) — tidak bisa diungkapkan sebagai CHECK.
- **Test 44/44 penuh via npm run test:integration**: hanya root (brief melarang saya menjalankannya); subset DB-backed 25 test baseline + 15 test baru = 40/40 hijau di DB termigrasi 0007.
- Tidak ada perubahan kontrak API/service; tidak ada perubahan .env; tidak ada git commit (root yang meng-commit).

## 9. Status yang disarankan

**Review** — implementasi selesai, semua verifikasi wajib brief lulus dengan bukti eksekusi di atas. Acceptance milik root.
