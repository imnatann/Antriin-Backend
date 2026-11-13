# Modul Orders — checkout atomik, state machine tenant, proposal jadwal

Status: **siap pakai untuk slice-nya** (bukan stub), diuji terhadap PostgreSQL 17 nyata.
Pemilik slice: orders-impl (task-7). Tabel milik slice ini: `orders`, `order_items`,
`order_item_options`, `order_payments`, `order_events`, `order_request_idempotency`,
`schedule_proposals`. Keputusan root yang mengikat: **D15** (urutan checkout + retry),
D3, D7, D8, D10, D12, D13, D14 di [../reviews/wave1-decisions.md](../reviews/wave1-decisions.md).

## 1. Urutan checkout resmi (D15) — WAJIB

Checkout adalah **satu transaksi PostgreSQL**. Urutannya dibekukan root karena schema 0007
memasang FK nyata `slot_reservations_order_fk (order_id) -> orders(id)`:

| #   | Langkah                                                                                       | Catatan                                                                                        |
| --- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | Idempotency claim: advisory lock per `(buyer, key_hash)` + `(buyer, payload)`                 | dua request paralel tidak menggandakan order; urutan lock tetap mencegah deadlock antar-domain |
| 2   | `CatalogService.quote(...)`                                                                   | recompute harga server; read-only, **tidak** memesan kapasitas                                 |
| 3   | `INSERT INTO orders` (`paid_awaiting_tenant`, `paid_at` NULL dulu)                            | order_number collision-safe (retry 23505)                                                      |
| 4   | `INSERT order_items` + `order_item_options`                                                   | snapshot; CHECK `line_total = unit_price * quantity`                                           |
| 5   | `AvailabilityService.reserveForCheckout(client, tenantId, slotId, ver, orderId)`              | **butuh baris orders sudah ada** (FK 23503 bila tidak)                                         |
| 6   | `WalletService.postTransfer` (debit buyer -> escrow) lalu `UPDATE orders SET paid_at = now()` | order baru dianggap lunas setelah ledger posted                                                |
| 7   | `INSERT order_payments` (`amount = total`, `succeeded`, ref ledger)                           | satu payment sukses per order (unique)                                                         |
| 8   | `order_events(order.created, request_id)` + `AuditService.append` + `OutboxService.append`    | aktor = buyer; recipient staf dihitung server                                                  |
| 9   | `UPDATE order_request_idempotency SET response_body`                                          | replay mengembalikan body yang identik                                                         |

Kegagalan pada langkah mana pun -> **rollback penuh**: tidak ada debit tanpa order, tidak ada
reservasi tanpa pembayaran. Test `rolls the wallet debit, the reservation and the order back
together` memaksa kegagalan pada `INSERT order_payments` (yaitu **setelah** debit dan
**setelah** reservasi) dan membuktikan saldo, escrow, `reserved_count`, order, item, payment,
event, dan record idempotency semuanya tidak berubah.

### Prasyarat FK (jangan diubah)

- `slot_reservations.order_id -> orders(id)` (0007). Karena itu reserve **selalu** setelah
  `INSERT orders`. Test `rejects a reservation for an order row that does not exist (FK 23503)`
  mengunci aturan ini.
- `orders(tenant_id, pickup_slot_id) -> pickup_slots(tenant_id, id)` (0007).
- `order_events.request_id -> order_request_idempotency(id)`; record idempotency ditulis
  sebelum event, `response_body` diisi di akhir transaksi.
- `order_request_idempotency.order_id NOT NULL` -> record ditulis setelah order ada.

### Kebijakan retry (D15.B)

- Transaksi checkout dibungkus `withTransactionRetry`: **maksimal SATU** percobaan ulang untuk
  SQLSTATE `40P01` (deadlock) dan `40001` (serialization failure). Sejak R2-02, slice
  availability memetakan error database menjadi `ConflictException` 409 dengan kode kontrak
  stabil, sehingga retry juga dipicu oleh kode kontrak **`DATABASE_DEADLOCK`**
  (`isRetryableTransactionError` menerima raw `40P01`/`40001` **dan** `HttpException` yang
  body-nya ber-`code: 'DATABASE_DEADLOCK'`). Error yang sudah dipetakan tidak wajib di-retry,
  tetapi karena kode itu hanya muncul dari deadlock/serialization dan transaksinya sudah
  di-rollback, satu retry tetap aman dan sesuai D15.
- Retry hanya membungkus transaksi yang **belum commit**, sehingga tidak pernah menggandakan
  efek finansial (idempotency + unique constraint ledger tetap menjadi jaring kedua).
- Kegagalan kedua -> `409 CHECKOUT_RETRY_CONFLICT`, bukan 500.
- Untuk mencegah deadlock sejak awal, checkout mengambil `assertBookableSlot(..., 'update')`
  pada baris slot **sebelum** memanggil quote. Dengan begitu `FOR SHARE` yang dilakukan quote
  bukan lagi lock upgrade. Test `lets 10 parallel checkouts on a large slot all succeed without
a deadlock` menjalankan 10 checkout paralel: semuanya sukses, `reserved_count` = jumlah order
  sukses, dan rekonsiliasi `reserved_count = COUNT(slot_reservations status IN
('reserved','consumed'))` terpenuhi.
- Bukti retry (4 test, semua deterministik, trigger/kontrak ber-scope tenant):
  1. `40P01` mentah dari statement milik slice ini (`UPDATE orders SET paid_at`) -> tepat **2**
     percobaan lalu `409 CHECKOUT_RETRY_CONFLICT`, tanpa order/debit/kursi tertinggal;
  2. kode kontrak `DATABASE_DEADLOCK` dari availability (disimulasikan pada percobaan pertama)
     -> tepat **2** panggilan reserve lalu checkout sukses;
  3. kode kontrak yang persisten -> `409 CHECKOUT_RETRY_CONFLICT` setelah tepat 2 percobaan,
     tanpa efek samping;
  4. `40P01` nyata yang dipetakan availability -> selalu 409 (tidak pernah 500) dan tidak ada efek
     samping; jumlah percobaan tetap <= 2.

### Pemetaan error database (R2-02)

Slice availability mengubah penolakan database menjadi 409 dengan kode kontrak:
`DATABASE_DEADLOCK` (40P01/40001), `REFERENCE_CONFLICT` (23503),
`CHECK_CONSTRAINT_VIOLATION` (23514), `SLOT_WINDOW_CONFLICT` / `RESERVATION_IN_PROGRESS`
(23505). Konsekuensi untuk slice ini:

- `isRetryableTransactionError` mengenali raw code **dan** kode kontrak `DATABASE_DEADLOCK`.
- Test FK tidak lagi menegaskan SQLSTATE mentah: reservasi untuk `orderId` yang belum ada harus
  menghasilkan `ConflictException` dengan kode `REFERENCE_CONFLICT` (dan tetap tidak menyisakan
  reservasi/kursi). Urutan checkout D15 (orders dulu, reserve kemudian) tetap yang mencegahnya.

## 2. Idempotency

- Header `Idempotency-Key` wajib (8..200 karakter `A-Z a-z 0-9 . _ :`), disimpan sebagai
  `key_hash = sha256(key)` pada `order_request_idempotency(actor_user_id, route_name='POST /v1/orders', key_hash)`.
- `request_hash` = sha256 payload kanonik (tenantId, slotId, expectedSlotVersion, specialRequest,
  baris item terurut sebagai string: menuItemId, quantity, optionIds terurut, notes).
- Perilaku:
  - key sama + hash sama -> order yang sama, `meta.replayed = true`, **tanpa** efek baru;
  - key sama + hash beda -> `409 IDEMPOTENCY_KEY_REUSED`;
  - key beda + hash sama (dalam masa retensi) -> `409 IDEMPOTENCY_PAYLOAD_REUSED`.
- Retensi: `expires_at = now() + 30 hari` (`IDEMPOTENCY_RETENTION_DAYS`). Job pembersih belum
  dibuat (pekerjaan wave operasional, R1-16).
- Dua advisory lock (per key, per payload) diambil dengan urutan tetap agar tidak saling deadlock.

## 3. Uang dan kapasitas

- Server **tidak pernah** menerima harga/total/status dari klien; total berasal dari
  `CatalogService.quote` dan `orders.total_minor = orders.subtotal_minor` (CHECK 0007).
- Uang = integer minor unit (numeric di DB, string desimal di API, BigInt di JS).
- Debit wallet buyer -> akun system **`orders.payment.escrow`** (`PAYMENT_ESCROW_SYSTEM_KEY`).
  Dana pembayaran ditahan terpisah dari payable tenant (PILOT-POLICY); akun ini **bukan** akun
  sandbox top-up. Nama akun dilaporkan ke root untuk registry akun system.
- Idempotency ledger diturunkan dari order id (`idempotencyScope='orders.checkout'`,
  `idempotencyKey=orderId`, `reference={namespace:'order', id:orderId}`), jadi retry tidak
  menggandakan debit.
- Kapasitas: `pickup_slots.version` adalah versi konfigurasi (D3). `expectedSlotVersion` dari
  quote diverifikasi; stale -> `409 SLOT_VERSION_CONFLICT`.
- Saldo kurang -> `409 INSUFFICIENT_WALLET_BALANCE` dari ledger; seluruh transaksi rollback.
  Test dua sumbu membuktikan: kapasitas K dari N paralel -> tepat K sukses; saldo hanya cukup K ->
  tepat K sukses dan sisanya gagal tanpa debit.

## 4. State machine tenant

| Transisi                                            | Permission                                              | Timestamp      | Event                  |
| --------------------------------------------------- | ------------------------------------------------------- | -------------- | ---------------------- |
| `paid_awaiting_tenant -> confirmed`                 | `tenant.orders.accept`                                  | `confirmed_at` | `order.status_changed` |
| `confirmed -> preparing`                            | `tenant.orders.prepare`                                 | `preparing_at` | `order.status_changed` |
| `preparing -> ready_for_pickup`                     | `tenant.orders.prepare` **atau** `tenant.orders.accept` | `ready_at`     | `order.status_changed` |
| `paid_awaiting_tenant` atau `confirmed -> declined` | `tenant.orders.accept` + `reason` wajib                 | `declined_at`  | `order.declined`       |

- `ready` menerima salah satu dari prepare/accept: dapur yang memegang `tenant.orders.prepare`
  dan owner/penerima order sama-sama boleh menandai siap. Keduanya dicek lewat
  `AccessService.requireTenant` di dalam transaksi yang sama.
- `prepare` dijaga `ORDER_PREPARATION_LEAD_SECONDS`: hanya boleh saat
  `now >= pickup_starts_at - lead`, kalau tidak `409 ORDER_PREPARATION_TOO_EARLY`. Persiapan
  tidak pernah otomatis.
- Transisi tidak sah -> `409 ORDER_STATE_CONFLICT`; replay transisi yang sama -> `200` idempoten
  tanpa event/audit kedua (dibandingkan lewat status target, bukan timestamp).
- `expectedStatus` opsional: klien mengirim balik status yang dilihat; mismatch -> 409.
- **Decline**: `reason` wajib (400 bila kosong), `AvailabilityService.releaseReservation`
  mengembalikan kapasitas tepat sekali, event `order.declined` mencatat
  `metadata.refundObligation = 'pending'` + penjelasan bahwa eksekusi refund ada di modul refunds
  wave 3 (setelah provider success + dedupe). **UANG TIDAK DIKREDIT** di slice ini.
- Setiap transisi menulis `order_events` + `audit_events` (scope tenant, actor sesi) + outbox
  `order.status_changed` ke buyer dalam transaksi yang sama.

## 5. Proposal jadwal (`schedule_proposals`)

- `POST /v1/tenants/:tenantId/orders/:orderId/schedule-proposals` (permission
  `tenant.orders.accept`): tenant mengajukan slot lain pada tenant yang sama.
  `expires_at = now() + ORDER_PROPOSAL_TTL_SECONDS` (default 600, bounds 60..3600).
  Slot tujuan divalidasi read-only (`assertBookableSlot`, tanpa reserve). Satu proposal pending
  per order (partial unique index) -> `409 SCHEDULE_PROPOSAL_PENDING`.
- `POST /v1/orders/:orderId/schedule-proposals/:proposalId/decision` (buyer pemilik order):
  - `accept` -> `moveReservation` + update `orders.pickup_slot_id/pickup_starts_at/pickup_ends_at`
    - `decided_at` + event `schedule_proposal.decided` + audit, semua atomik;
  - `reject` -> `decided_at`, status `rejected`, **slot tidak berubah**;
  - replay keputusan yang sama -> `meta.replayed = true`; keputusan berbeda -> 409.
- **Expiry tidak pernah auto-accept**: tidak ada job. Status `expired` hanya ditandai saat
  proposal dibaca (`GET /v1/orders/:id`, `GET /v1/tenants/:t/orders/:id`) atau saat keputusan
  dicoba dan `expires_at <= now()`. Expiry tidak memindahkan slot, tidak memulai produksi, tidak
  merefund. Keputusan atas proposal kedaluwarsa -> `409 SCHEDULE_PROPOSAL_EXPIRED`.
- `decided_at` diisi tepat ketika status keluar dari `pending_buyer` (CHECK 0007), dan
  `expires_at > created_at` juga dijaga CHECK.

## 6. Endpoint HTTP (prefix global /v1)

| Method & path                                                   | Auth        | Permission                                          | Deskripsi                                                                                                                       |
| --------------------------------------------------------------- | ----------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `POST /orders`                                                  | sesi buyer  | kepemilikan sesi                                    | Checkout atomik. Wajib header `Idempotency-Key`. Selalu 201; replay mengembalikan body yang sama dengan `meta.replayed = true`. |
| `GET /orders`                                                   | sesi buyer  | milik sendiri                                       | Daftar order buyer, cursor (`limit` 1..100, default 25) + filter `status`.                                                      |
| `GET /orders/:orderId`                                          | sesi buyer  | milik sendiri                                       | Detail + snapshot item/opsi + payment + proposal terakhir. Order buyer lain -> **404**.                                         |
| `POST /orders/:orderId/schedule-proposals/:proposalId/decision` | sesi buyer  | milik sendiri                                       | `{decision: accept}` atau `{decision: reject}`.                                                                                 |
| `GET /tenants/:tenantId/orders`                                 | sesi tenant | `tenant.orders.read`                                | Antrean tenant, cursor + filter status.                                                                                         |
| `GET /tenants/:tenantId/orders/:orderId`                        | sesi tenant | `tenant.orders.read`                                | Detail order dalam tenant.                                                                                                      |
| `POST /tenants/:tenantId/orders/:orderId/confirm`               | sesi tenant | `tenant.orders.accept`                              | `paid_awaiting_tenant -> confirmed`.                                                                                            |
| `POST /tenants/:tenantId/orders/:orderId/decline`               | sesi tenant | `tenant.orders.accept`                              | `reason` wajib; lepas reservasi + catat kewajiban refund (tanpa kredit wallet).                                                 |
| `POST /tenants/:tenantId/orders/:orderId/prepare`               | sesi tenant | `tenant.orders.prepare`                             | `confirmed -> preparing`, dijaga lead time.                                                                                     |
| `POST /tenants/:tenantId/orders/:orderId/ready`                 | sesi tenant | `tenant.orders.prepare` atau `tenant.orders.accept` | `preparing -> ready_for_pickup`.                                                                                                |
| `POST /tenants/:tenantId/orders/:orderId/schedule-proposals`    | sesi tenant | `tenant.orders.accept`                              | Ajukan slot baru (pending_buyer).                                                                                               |

Semua timestamp respons adalah string mikrodetik dari DB
(`to_char(... AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, D7) dan tidak pernah
di-serialize ulang lewat `new Date()`. Uang dikirim sebagai string desimal
(`^(0|[1-9][0-9]{0,37})$` untuk input; total order > 0).

## 7. Kontrak untuk slice pickup (signature final)

```ts
getOrderForHandover(client, tenantId, orderId)
  -> { orderId, tenantId, buyerId, status, pickupSlotId, totalMinor, currency }

markHandedOver(client, tenantId, orderId, actorUserId): Promise<void>
```

- Keduanya menerima `PoolClient` milik transaksi pemanggil (handover + consume + event + audit
  harus satu transaksi).
- `getOrderForHandover` melakukan `SELECT ... FOR SHARE` pada `(orderId, tenantId)`; order tenant
  lain -> 404. Method ini **tidak** mengotorisasi; pemanggil wajib sudah memeriksa
  `tenant.orders.handover`.
- `markHandedOver` memvalidasi `tenant.orders.handover` (defense in depth), hanya menerima status
  `ready_for_pickup` (selain itu `409 ORDER_STATE_CONFLICT`), men-set `completed` +
  `completed_at`, memanggil `consumeReservation` (kursi tetap terpakai pada slotnya), lalu
  menulis `order_events` + audit `order.completed`. Replay untuk order yang sudah `completed`
  = no-op.
- `order_handovers` ditulis oleh slice pickup (satu penulis per tabel, D4), bukan oleh modul ini.

## 7b. Kontrak untuk slice refunds/cases (signature final)

```ts
cancelForRefundDecision(
  client: PoolClient,
  orderId: string,
  actorUserId: string,
  reason: string,
): Promise<{
  orderId: string;
  buyerId: string;
  tenantId: string;
  status: string;
  totalMinor: string;
  currency: string;
  orderPaymentId: string;
}>
```

Dipakai modul refunds/cases (wave 3) saat keputusan pengelola kampus adalah
membatalkan order. Satu penulis per tabel (D4): modul lain tidak pernah
meng-update `orders`; mereka memanggil method ini **di dalam transaksinya sendiri**
(caller memegang BEGIN/COMMIT dan otorisasi aktornya).

Perilaku:

- `SELECT ... FROM orders WHERE id = $1 FOR UPDATE`; `buyerId`, `tenantId`,
  `totalMinor`, dan `currency` **selalu diambil dari baris itu**, bukan dari parameter.
- `409 ORDER_CANCEL_CONFLICT` bila status sudah `completed`, `cancelled`, atau `declined`
  (dana sudah terserahkan, atau order sudah terminal sehingga tidak boleh dibatalkan dua kali).
- `409 ORDER_PAYMENT_NOT_REFUNDABLE` bila order tidak punya baris `order_payments` sukses
  (tidak ada pembayaran yang bisa direfund).
- Set status `cancelled`, `cancelled_at = now()`, `version = version + 1`,
  `updated_at = now()` — memenuhi CHECK 0007 `orders_status_timestamps_check` (cancelled wajib
  punya `cancelled_at`) dan `orders_timestamps_monotonic_check`.
- `AvailabilityService.releaseReservation` idempoten: kursi dikembalikan tepat sekali; replay
  atau reservasi yang sudah `released` = no-op. Reservasi yang tidak pernah ada bukan kegagalan
  pembatalan.
- Menulis `order_events` `order.cancelled` (actor = `actorUserId`, reason = alasan keputusan),
  audit `tenant.orders.cancelled_by_manager` (scope tenant, reason wajib) dan outbox notifikasi
  ke buyer, semuanya dalam transaksi yang sama.
- `reason` wajib non-empty (maks 500 karakter); kosong -> 400.
- Uang **tidak** berpindah di sini: refund dieksekusi modul refunds setelah provider sukses dan
  dedupe. `orderPaymentId` adalah referensi yang harus direfund.

## 7c. P2-05 — lock tenant vs archive (write skew)

Checkout dan transisi status order memanggil `lockTenantForOrderCommitment` sebagai langkah
pertama: `SELECT ... FROM tenants JOIN campuses ... FOR SHARE OF t, c` pada tenant yang
`status <> 'archived'` dan kampus `active`. `TenantsService.archive` mengunci baris yang sama
dengan `FOR UPDATE` sebelum menghitung dependensi, sehingga kedua jalur terserialisasi:

- archive lebih dulu -> checkout membaca tenant `archived` dan gagal 404; **tidak ada order yang
  lahir pada tenant terarsip**;
- checkout lebih dulu -> `UPDATE tenants` menunggu sampai transaksi order commit, lalu archive
  ditolak `409` karena hitungan dependensi (active order) sudah mencakup order baru.

`FOR SHARE` (bukan `FOR UPDATE`) dipilih agar checkout paralel pada tenant yang sama tetap
berjalan bersamaan; hanya penulis baris tenant yang diblokir.

## 7d. Retry 40P01 (konfirmasi)

Checkout tetap membungkus transaksi dengan `withTransactionRetry`: maksimal SATU retry untuk
SQLSTATE `40P01`/`40001`, kegagalan kedua -> `409 CHECKOUT_RETRY_CONFLICT` (bukan 500). Tidak
ada perubahan pada kebijakan ini; lihat bagian 1.

## 8. Order number

Format `AN-YYYYMMDD-XXXXXX` (18 karakter):

- `YYYYMMDD` = tanggal UTC pembuatan (bukan rahasia, terurut).
- `XXXXXX` = 6 karakter Crockford base32 (`0-9 A-Z` tanpa `I L O U`) dari `crypto.randomBytes`,
  agar mudah dibacakan staf tanpa ambiguitas.
- **Collision-safe**: unique index `orders_order_number_uq` + retry maksimal
  `ORDER_NUMBER_ATTEMPTS = 5` di dalam savepoint (unique violation tidak membatalkan transaksi).
  Bila semua percobaan gagal -> `409 ORDER_NUMBER_GENERATION_FAILED`.
- Order number **bukan** token keamanan; validasi pickup memakai `pickup_credentials`
  (AGENTS.md: jangan mengandalkan nomor order berurutan sebagai rahasia).

## 9. Test (PostgreSQL nyata)

```sh
npx tsc -p tsconfig.test.json --outDir .test-dist-orders
TEST_DATABASE_URL=postgresql://...:5544/antriin_orders \
  node --test .test-dist-orders/test/orders.spec.js \
            .test-dist-orders/test/orders-state-machine.spec.js \
            .test-dist-orders/test/orders-http.spec.js \
            .test-dist-orders/test/orders-refund-cancellation.spec.js \
            .test-dist-orders/test/orders-tenant-archive.spec.js
```

42 test lulus (13 + 10 + 7 + 3 PostgreSQL, 9 HTTP kontrak), stabil pada eksekusi berulang dengan kelima file berjalan paralel:

- `test/orders.spec.ts`: graf order lengkap dalam satu transaksi (item/opsi snapshot, payment,
  ledger double-entry, event, audit, outbox, saldo turun tepat total, `reserved_count` +1),
  rollback penuh setelah debit, idempotency (key sama paralel, key sama payload beda, key beda
  payload sama), konkurensi kapasitas (K dari N) dan saldo, stale version/tenant tutup, validasi
  input, invariant 0007 (`total != subtotal`, `line_total` salah, quantity, monotonicity, satu
  payment per order), retry 40P01 tepat sekali -> 409, reserve untuk order yang belum ada -> 23503,
  order number unik.
- `test/orders-state-machine.spec.ts`: transisi sah berurutan, transisi tidak sah 409, replay
  idempoten, decline (reason wajib, kapasitas kembali, tanpa kredit wallet), proposal
  ajukan/approve (reservasi + slot order pindah), reject (tidak berubah), satu pending per order,
  expiry tidak auto-accept, scope (buyer lain 404, staf tenant lain 403, permission kurang 403),
  cursor pagination, dan kontrak handover pickup.
- `test/orders-http.spec.ts`: kontrak HTTP — header `Idempotency-Key` wajib dan validasinya,
  penolakan field asing/harga/total/status dari klien (whitelist global), batas quantity dan
  keranjang, `reason` wajib saat decline, nilai `decision` yang sah, validasi query list, kode
  error 409 yang stabil, dan 401 tanpa bearer token di semua route.
- `test/orders-refund-cancellation.spec.ts` (7, PostgreSQL): pembatalan oleh keputusan refund dari
  `paid_awaiting_tenant`/`confirmed`/`preparing`/`ready_for_pickup` (status, `cancelled_at`,
  reservasi released, event + audit + outbox, `orderPaymentId` benar); penolakan 409 tanpa efek
  samping untuk `completed`/`cancelled`/`declined`; dua pembatalan paralel -> tepat satu menang;
  replay tidak menulis event/audit ganda; `reason` wajib; order tak dikenal -> 404.
- `test/orders-tenant-archive.spec.ts` (3, PostgreSQL): P2-05 — checkout pada tenant yang sudah
  terarsip -> 404 tanpa order; checkout vs archive paralel -> tepat satu menang (archive 409 bila
  checkout menang, atau checkout 404 bila archive menang) dan tidak ada order pada tenant
  terarsip; archive memblokir selama transaksi checkout memegang lock baris tenant.

## 10. Keputusan, asumsi, dan sisa pekerjaan

- **Akun ledger baru**: `orders.payment.escrow` (system). Alasan: dana pembayaran harus ditahan
  terpisah dari payable tenant (PILOT-POLICY) dan tidak boleh memakai akun sandbox top-up.
  Nama ini dilaporkan ke root untuk dicatat di dokumen keputusan.
- **Pilot tanpa fee/pajak**: `total = subtotal` (CHECK DB). Refund penuh satu kali hanya dieksekusi
  modul refunds wave 3 setelah provider success; slice ini hanya mencatat kewajiban refund.
- **Batas operasional DTO**: baris 1..50, quantity 1..200, opsi 1..50 per baris, catatan 500
  karakter (DB lebih longgar: quantity 1..999, D12 R1-22).
- `PRE_PRODUCTION_STATUSES = ['paid_awaiting_tenant','confirmed']` dipakai untuk decline dan
  proposal. `cancelled` (pembatalan oleh pengelola kampus) **belum** diimplementasikan di slice
  ini; jalurnya milik modul cases/refunds.
- Notifikasi: hanya outbox `order.created`, `order.status_changed`,
  `schedule_proposal.created`, `schedule_proposal.decided` (tipe yang sudah ada di
  `DOMAIN_EVENT_TYPES`). Tidak menambah tipe event.
- Belum ada: job pembersih idempotency (`expires_at`), read API event/audit untuk buyer,
  pembatalan oleh kampus, dan integrasi pickup credential (milik slice pickup).
