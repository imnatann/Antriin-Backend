# Modul Settlements (payable tenant)

Slice ini melepas dana order dari escrow ke **payable tenant** dan menyediakan bacaan keuangan tenant
(ringkasan + feed transaksi). Skema sudah ada di migrasi `0009`
(`src/database/schema/settlements.ts`) dan tidak diubah oleh modul ini. Desain lengkap:
[docs/design/settlement-payout.md](../design/settlement-payout.md) §2–§6; keputusan root:
[docs/reviews/wave1-decisions.md](../reviews/wave1-decisions.md) D18 (Q1–Q10 sudah final).

Aturan yang dipegang (AGENTS.md, docs/PILOT-POLICY.md):

- pembayaran sukses **bukan** dana tersedia; dana order ditahan di akun system `orders.payment.escrow`;
- release payable hanya bila order **completed** (handover) **dan** tidak ada kasus operasional terbuka
  **dan** tidak ada refund untuk order itu;
- saldo tersedia = **proyeksi ledger** akun `tenant.payable.<tenantId>`, bukan kolom;
- semua perpindahan dana lewat `WalletService.postTransfer` (double-entry, idempoten);
- hanya **pemilik tenant terverifikasi** yang dapat membaca keuangan tenant.

## Endpoint

| Method | Path                                         | Permission            | Catatan                                       |
| ------ | -------------------------------------------- | --------------------- | --------------------------------------------- |
| GET    | `/v1/tenants/:tenantId/finance/summary`      | `tenant.finance.read` | ringkasan turunan (bukan kolom saldo)         |
| GET    | `/v1/tenants/:tenantId/finance/transactions` | `tenant.finance.read` | feed ledger akun payable/hold, cursor + limit |

Semua route memerlukan bearer token (`AuthGuard`) dan memakai `tenantId` dari **path** (bukan body).
`AccessService.requireTenant` menolak semua role selain `owner`, dan owner wajib
`owner_verified_at NOT NULL`; jadi **staf kitchen/pickup selalu 403** untuk `tenant.finance.read`,
`tenant.bank_account.manage`, dan `tenant.payout.request` sekalipun permission-nya disetel manual
(`src/modules/access/access.service.ts`, D10). Tenant lain -> 403/404 dari access, bukan kebocoran data.

Uang selalu integer minor unit sebagai **string desimal**; timestamp respons adalah string mikrodetik
UTC dari database (D7), bukan hasil `Date.toISOString()`.

### Ringkasan keuangan

`GET /v1/tenants/:tenantId/finance/summary` mengembalikan `{ data: { ... } }`:

| Field             | Sumber                                                                  |
| ----------------- | ----------------------------------------------------------------------- |
| `paidInMinor`     | Σ `order_payments.amount_minor` (status `succeeded`) untuk order tenant |
| `refundedMinor`   | Σ `refunds.amount_minor` berstatus `succeeded`                          |
| `unfinishedMinor` | Σ `orders.total_minor` untuk order yang belum terminal                  |
| `availableMinor`  | `wallet_accounts.balance_minor` akun `tenant.payable.<tenantId>`        |
| `heldMinor`       | `wallet_accounts.balance_minor` akun `tenant.payout.hold.<tenantId>`    |
| `paidOutMinor`    | Σ `payouts.amount_minor` berstatus `succeeded`                          |
| `releasedMinor`   | Σ `settlements.amount_minor` berstatus `available`/`paid_out`           |
| `currency`        | selalu `IDR` (pilot)                                                    |

Akun yang belum ada dibaca sebagai `0`; modul ini **tidak** membuat akun pada jalur baca.

### Feed transaksi

`GET /v1/tenants/:tenantId/finance/transactions?cursor=&limit=` mengembalikan
`{ data: [...], meta: { next_cursor } }`. Satu baris = satu `ledger_entries` pada akun payable/hold
tenant, dengan `type` diturunkan dari `reference_namespace`:
`settlement_release`, `payout_hold`, `payout_settle`, `payout_release`, atau `other`.
Cursor adalah pasangan `(created_at, id)` mikrodetik yang di-encode base64url; cursor/limit tidak sah
-> 400. Field asing pada query ditolak `ValidationPipe` (whitelist + forbidNonWhitelisted).

## Alur release

```text
order completed (handover pickup)  atau  keputusan kasus terminal non-cancel
  -> SettlementsService.releaseForOrder(client, tenantId, orderId, actor)
      1. cek settlements(order_id)                 -> sudah ada? already_released (tanpa posting)
      2. FOR UPDATE orders (lewat orders slice)    -> bukan completed? not_completed
      3. FOR SHARE cases terbuka (lewat cases)     -> ada? open_case
      4. cek refunds(order_id)                     -> ada? refund_pending
      5. ambil amount dari order_payments          -> tidak ada? payment_missing
      6. lock akun payable (FOR UPDATE) lalu postTransfer
           debit  orders.payment.escrow
           kredit tenant.payable.<tenantId>
           idempotency 'settlements.release:<orderId>'
           reference namespace 'settlement_release', id = orderId
      7. INSERT settlements (status 'available', release_ledger_transaction_id, released_at)
      8. audit 'tenant.payable.released'
```

Status settlement: `pending` -> `available` -> `paid_out` (terminal), `voided`/`reversed` cadangan
sesuai CHECK 0009. Pada pilot baris **lahir langsung `available`** saat release; tidak ada baris
`pending` yang dipersistensikan, sehingga checkout (sudah diterima) tidak perlu menulis ke tabel ini.

### Pemicu (D18 Q2)

1. **Handover pickup (Q2a).** `PickupService.handover` memanggil
   `SettlementsService.releaseAfterHandover` **di dalam transaksi yang sama**, tepat setelah
   `OrdersService.markHandedOver` berhasil. Order sudah terkunci oleh `markHandedOver`, jadi tidak ada
   urutan lock baru.
2. **Keputusan kasus terminal (Q2b).** `CasesService.decideCase` memanggil
   `releaseAfterCaseDecision` untuk keputusan terminal **selain** `approved_cancel`
   (`resolved`/`declined`), juga di transaksi yang sama.
3. **Job penyapu: DITUNDA (Q2c).** Tidak ada job yang menyapu order `completed` yang tertahan; ini
   pekerjaan operasional yang menyentuh slice lain.

### Kegagalan release TIDAK boleh menggagalkan handover/keputusan

Keputusan root: handover yang sah selalu menang. `releaseAfterHandover` / `releaseAfterCaseDecision`
karena itu:

- mengambil **savepoint** `settlement_release_attempt` sebelum memanggil `releaseForOrder`. Ini wajib:
  error PostgreSQL membatalkan seluruh transaksi, sehingga `try/catch` biasa tidak cukup - rollback
  ke savepoint membuat transaksi pemanggil tetap sehat dan `COMMIT` handover tetap berhasil;
- bila release melempar error: rollback ke savepoint, `Logger.warn`, dan audit
  `tenant.payable.release_failed` (metadata `{ source, errorCode }`, tanpa PII);
- bila release ditolak aturan bisnis (`not_completed`, `open_case`, `refund_pending`, ...): audit
  `tenant.payable.release_deferred` dengan `reason`;
- `already_released` dan `not_found` tidak menulis audit (replay normal).

Uangnya tetap di escrow dan dapat dilepas kemudian oleh release ulang (manual/retry) karena
`releaseForOrder` idempoten. Pemanggil (pickup/cases) juga membungkus panggilan ini dengan
`try/catch` sebagai lapisan kedua.

**Dependensi wajib (F2).** `PickupService` sekarang **mewajibkan** `SettlementsService` (bukan
`@Optional()`). Sebelumnya injeksi opsional + pemanggilan yang dibungkus `catch {}` membuat hook
release bisa tidak pernah berjalan tanpa satu pun error: `test/pickup.spec.ts` mengonstruksi
`PickupService` tanpa argumen settlements, sehingga 16 test pickup lulus tanpa pernah mengeksekusi
pemicu release. Dengan dependensi wajib, wiring yang rusak gagal saat boot modul
(`test/payouts-di.spec.ts`), dan `test/pickup.spec.ts` membangun `SettlementsService` asli serta
membuktikan: handover sukses -> satu baris `settlements` `available` + satu leg ledger seimbang
(escrow debit = `tenant.payable.<tenantId>` credit = total order); dan bila release melempar error,
handover tetap sukses/COMMIT tanpa settlement, tanpa hold, dengan dana tetap di escrow dan release
masih dapat diulang.

## Akun ledger (D16.1 + D18 Q1)

| System key                      | Status | Peran                                                    |
| ------------------------------- | ------ | -------------------------------------------------------- |
| `orders.payment.escrow`         | ada    | dana pembayaran buyer ditahan; debit saat release/refund |
| `tenant.payable.<tenantId>`     | baru   | dana tenant yang sudah dirilis dan tersedia untuk payout |
| `tenant.payout.hold.<tenantId>` | baru   | dana yang di-hold payout aktif (dipakai slice payouts)   |
| `payout.clearing`               | baru   | counter-account keluar ke provider (boleh negatif)       |

`(reference_namespace, reference_id)` unik **global** pada `ledger_transactions`, karena itu setiap leg
memakai namespace sendiri (`settlement_release`, `payout_hold`, `payout_settle`, `payout_release`).
Memakai satu namespace akan menggagalkan leg kedua dengan 409.

### Identitas rekonsiliasi yang diuji (§4.4)

```text
(1) payable + hold + Σ payouts.succeeded = Σ settlements(released)
(2) Σ payout_allocations per payout     = payouts.amount_minor
(3) Σ payout_allocations per settlement = settlements.paid_out_minor
(4) escrow = Σ order_payments − Σ refunds.succeeded − Σ settlements(released)
(5) Σ settlements(released) = Σ order_payments untuk order completed tanpa refund
```

## Invariant yang dijaga database

- `settlements_one_per_order_uq`: satu settlement per order (release kedua ditolak DB; service
  memetakannya menjadi `already_released`).
- FK komposit `(tenant_id, order_id) -> orders` dan `(order_id, order_payment_id) -> order_payments`:
  settlement tidak dapat menunjuk order/pembayaran tenant lain.
- `settlements_amount_check`, `settlements_currency_check` (`IDR`), `settlements_paid_out_check`
  (`0 <= paid_out_minor <= amount_minor`).
- `settlements_status_timestamps_check` (bidireksional): status <-> `released_at`/`voided_at`/
  `reversed_at`/`release_ledger_transaction_id`/`paid_out_minor`.
- `ledger_transactions_idempotency_uq` + `ledger_transactions_reference_uq`: posting ulang
  mengembalikan transaksi yang sama (`replayed=true`), bukan transfer kedua.

Tidak dapat dijaga CHECK (dijaga service + test): urutan lock, kewajiban `amount_minor =
order_payments.amount_minor`, dan "tidak ada kasus terbuka" (kombinasi lintas tabel `orders` +
`cases`).

### Urutan lock (anti-deadlock)

```text
settlements(order_id) -> orders FOR UPDATE -> cases FOR SHARE -> refunds -> escrow -> payable FOR UPDATE -> postTransfer
```

Lock payable selalu diambil **sebelum** `postTransfer` (yang juga `FOR UPDATE` dua akun urut id).
Slice payouts memakai urutan yang sama (payable lebih dulu), sehingga release dan payout satu tenant
terserialisasi pada baris akun payable, bukan saling menunggu.

Dua jalur pemanggil tidak memakai urutan lock yang identik - handover mengambil `orders` lebih dulu,
keputusan kasus sudah memegang baris `cases` lebih dulu - sehingga secara teori PostgreSQL dapat
mendeteksi deadlock (`40P01`) di antara keduanya untuk order yang sama. Dampaknya tetap terkendali:
release berjalan **di dalam savepoint**, dan `ROLLBACK TO SAVEPOINT` memulihkan transaksi setelah
`40P01`/`40001`, jadi keputusan kasus/handover tetap `COMMIT` (hanya release-nya yang tertunda dan
tercatat audit); handover juga sudah punya retry-satu-kali D15.3. Ini sengaja tidak "diperbaiki" dengan
menambah lock pada baris order di slice cases, karena itu akan mengubah perilaku slice lain (D4).

## Kontrak lintas slice

Semua method menerima `PoolClient` milik transaksi pemanggil dan tidak pernah commit/rollback sendiri.

| Method                                                               | Pemilik | Dipakai oleh                |
| -------------------------------------------------------------------- | ------- | --------------------------- |
| `releaseForOrder(client, tenantId, orderId, actor)`                  | slice   | release manual/retry, test  |
| `releaseAfterHandover(client, tenantId, orderId, actorUserId)`       | slice   | `PickupService.handover`    |
| `releaseAfterCaseDecision(client, tenantId, orderId, actorUserId)`   | slice   | `CasesService.decideCase`   |
| `getAvailableBalance(client, tenantId, 'IDR')`                       | slice   | slice payouts, ringkasan    |
| `OrdersService.getOrderSettlementContext(client, tenantId, orderId)` | orders  | slice settlements           |
| `CasesService.hasOpenCasesForOrder(client, tenantId, orderId)`       | cases   | slice settlements           |
| `WalletService.lockSystemAccount(systemKey, currency, client)`       | wallet  | slice settlements + payouts |

Tiga method terakhir adalah **penambahan kecil** pada slice lain (method baru, perilaku lama tidak
berubah); schema/migrasi tidak disentuh. Dependensi melingkar `settlements <-> cases` diselesaikan
dengan `forwardRef` di kedua module. Parameter `SettlementsService` pada `CasesService` masih
`@Optional()`, tetapi pada **`PickupService` sudah WAJIB** (F2): hook release handover adalah satu-satunya
jalur yang memindahkan uang order ke payable, jadi wiring yang hilang harus gagal keras. Smoke test
`test/payouts-di.spec.ts` mem-boot `PickupModule + CasesModule + SettlementsModule + PayoutsModule`
bersama dan memastikan keempat injeksi terisi serta siklus `forwardRef` resolve.

## Kode error kontrak

Release dipanggil dari transaksi slice lain dan **tidak** melempar error untuk aturan bisnis: ia
mengembalikan hasil terdiskriminasi (`{ released: false, reason }`) dengan alasan
`not_found` | `not_completed` | `open_case` | `already_released` | `refund_pending` |
`payment_missing` | `currency_unsupported`. Kode stabil terkait (dipakai audit/log, bukan HTTP):
`SETTLEMENT_NOT_HANDED_OVER`, `SETTLEMENT_OPEN_CASE_BLOCKED`, `SETTLEMENT_REFUND_PENDING`,
`SETTLEMENT_ALREADY_RELEASED`, `SETTLEMENT_PAYMENT_MISSING`, `SETTLEMENT_CURRENCY_UNSUPPORTED`.

Endpoint baca memakai kode HTTP standar: 400 (uuid/cursor/limit tidak sah), 401, 403 (bukan pemilik
terverifikasi), 404/403 dari access untuk tenant lain.

## Keputusan D18 dan batasan

- **Q1 akun payable per tenant: disetujui.** Saldo tersedia = proyeksi ledger per akun, tidak pernah
  kolom; isolasi tenant ditegakkan akun + `tenantId` dari path/sesi.
- **Q2 pemicu: (a) handover + (b) keputusan kasus terminal; (c) job penyapu ditunda.**
- **Q3 refund setelah release: DITOLAK.** `cancelForRefundDecision` sudah menolak order
  `completed`, dan release menolak order yang punya baris refund. Tidak ada clawback.
- **Q5 nominal:** `amount > 0`, tidak ada minimum/maksimum operasional; payout parsial diizinkan.
- **Q6 penjaga DB saldo negatif: DITUNDA.** `wallet_accounts_balance_nonnegative_check` hanya
  berlaku untuk `account_type='wallet'`, jadi akun system bisa negatif. Pengganti sementara: lock +
  perbandingan `BigInt` + test konkurensi. Trigger DB untuk `tenant.payable.%`/`tenant.payout.hold.%`
  dicatat sebagai pekerjaan migrasi berikutnya (milik root).
- **Q7 retensi/rekonsiliasi: ditunda** (identitas §4.4 sudah lulus test; penjadwalan belum).
- **Q8 fee tidak dimodelkan** - tidak ada kolom fee/net; total = gross.
- **Batasan lain:** belum ada endpoint mutasi settlement (release hanya dipicu handover/kasus/retry
  internal), belum ada void settlement dari slice refunds (refund dan release saling eksklusif per
  order), dan belum ada job penyapu order `completed` yang tertahan.

### Ditunda: pemantauan kampus (F9)

`GET /v1/campuses/:campusId/settlements` (`campus.transactions.read`, desain §7) **belum dibuat**.
Alasannya: permintaan review F9 hanya mewajibkan endpoint pemantauan payout, dan menambah endpoint
kedua memperluas permukaan baca lintas modul (ringkasan settlement per kampus butuh agregasi
`settlements` + `orders` + `payout_allocations` yang belum punya kontrak). Status penundaan ini
dicatat eksplisit di sini dan di [payouts.md](payouts.md); route **tidak** didaftarkan, sehingga
request ke path itu menghasilkan 404 (bukan 200 kosong). Yang sudah ada: pemantauan payout kampus
`GET /v1/campuses/:campusId/payouts` (`campus.payouts.read`, read-only, tersamarkan).

## Pengujian

`test/settlements.spec.ts` (13 test PostgreSQL): release memindahkan tepat `amount_minor` (dibuktikan
pada entri ledger transaksi release itu sendiri, bukan saldo global akun escrow yang dipakai bersama);
idempoten (replay `already_released`, satu transaksi ledger, satu baris settlement); **4 release
paralel -> tepat satu menang tanpa posting kedua**; ditolak untuk order belum `completed`, kasus
terbuka (lalu berhasil setelah kasus `resolved`), refund ada, dan tenant lain; kegagalan release
terkurung savepoint (transaksi pemanggil tetap sehat + audit `release_failed`); penundaan aturan bisnis
diaudit (`release_deferred`); keputusan kasus terminal melepas payable dalam transaksi yang sama;
ringkasan + feed diturunkan dari proyeksi ledger (timestamp mikrodetik); kitchen staff ditolak; dan
identitas rekonsiliasi §4.4 (1)(4)(5).

`test/settlements-http.spec.ts` (5 test transport, tanpa DB): 401 di kedua route, bentuk respons
(string minor unit, timestamp mikrodetik), 403 saat service menolak, paging + limit/cursor/field asing
ditolak 400, dan tenant id tidak sah ditolak sebelum service.

`test/schema-integrity-0009.spec.ts` (14 test PostgreSQL, review F1): constraint migrasi 0009 diuji
dengan SQL langsung - setiap pelanggaran diassert lewat SQLSTATE + nama constraint persis, dan tiap
kelompok punya kontrol positif. Cakupan: `settlements_one_per_order_uq`, FK komposit
`settlements_tenant_order_fk`/`settlements_order_payment_fk` (23503), `settlements_amount_check`
(0/negatif/pecahan), `settlements_status_timestamps_check` (`available` tanpa `released_at`,
`paid_out` dengan `paid_out_minor != amount`, `pending`/`voided`), `payouts_one_active_per_tenant_uq`,
`payouts_ledger_legs_check` (dua leg terminal, `succeeded` tanpa settle, `failed` tanpa release),
`payouts_amount_check`, `bank_accounts_verification_check`, `bank_accounts_hash_check`,
`payout_allocations` UNIQUE + FK komposit lintas tenant, `payout_provider_events`,
`payout_attempts_no_check`/`finished_check`, dan `payout_events_actor_check`/`version_uq`.
