# Modul Refunds & Cases (KAN-31, KAN-68)

Dua slice after-sales yang saling terikat: **cases** adalah catatan keputusan manusia, **refunds** adalah eksekusi pengembalian dana yang hanya terjadi setelah keputusan berizin dan konfirmasi provider. Skema keduanya ada di migrasi `0008` (`src/database/schema/cases.ts`, `refunds.ts`) dan tidak diubah oleh modul ini.

Aturan yang dipegang (AGENTS.md, docs/PILOT-POLICY.md):

- keputusan pembatalan hanya oleh pengelola kampus berizin, dengan alasan, dan tercatat audit;
- keputusan membuat **refund pending**, bukan kredit saldo;
- saldo hanya bertambah setelah provider mengonfirmasi **sukses**, dan kredit dideduplikasi;
- refund pilot = **penuh, satu kali** per order; refund parsial ditolak;
- kasus setelah pickup hanya menjadi bahan tinjauan manusia, tidak memicu refund otomatis.

## Endpoint

### Cases

| Method | Path                                            | Aktor               | Permission                                                                  |
| ------ | ----------------------------------------------- | ------------------- | --------------------------------------------------------------------------- |
| POST   | `/v1/orders/:orderId/cases`                     | buyer pemilik order | sesi buyer + kepemilikan order                                              |
| GET    | `/v1/me/cases` / `/v1/me/cases/:caseId`         | buyer               | hanya kasus miliknya                                                        |
| POST   | `/v1/tenants/:tenantId/cases`                   | staf tenant         | `tenant.incidents.report`                                                   |
| GET    | `/v1/tenants/:tenantId/cases` (+ `/:caseId`)    | staf tenant         | `tenant.orders.read`                                                        |
| POST   | `/v1/campuses/:campusId/cases`                  | campus admin        | `campus.cases.read`                                                         |
| GET    | `/v1/campuses/:campusId/cases` (+ `/:caseId`)   | campus admin        | `campus.cases.read`                                                         |
| POST   | `/v1/campuses/:campusId/cases/:caseId/decision` | campus admin        | `campus.cases.decide` (+ `campus.refunds.initiate` untuk `approved_cancel`) |

### Refunds

| Method | Path                             | Aktor               | Permission                 |
| ------ | -------------------------------- | ------------------- | -------------------------- |
| GET    | `/v1/orders/:orderId/refund`     | buyer pemilik order | sesi buyer + kepemilikan   |
| POST   | `/v1/campuses/:campusId/refunds` | campus admin        | `campus.refunds.initiate`  |
| GET    | `/v1/campuses/:campusId/refunds` | campus admin        | `campus.transactions.read` |

Status respons: `POST` yang membuat baris baru (buka kasus, buat refund) menjawab **201**; `POST .../decision` menjawab **200** karena hanya mengubah status kasus yang sudah ada (sesuai `@ApiOkResponse`). Semua route memakai envelope `{ data }` / `{ data, meta }`.

## Alur keputusan

```text
kasus dibuka (buyer / staf tenant / campus admin)
  -> reported -> under_review -> awaiting_information
  -> keputusan campus admin:
       declined / resolved        : hanya catatan + audit (tanpa uang)
       approved_cancel            : SATU transaksi
            1. OrdersService.cancelForRefundDecision  (order cancelled,
               cancelled_at, version+1, reservasi dilepas, order_events
               'order.cancelled', audit, outbox ke buyer)
            2. INSERT refunds status 'requested' (amount = order_payments
               .amount_minor, full refund) + refund_request_outbox
            -> wallet TIDAK dikredit di sini
```

Pemrosesan refund (worker `refund-requests`):

```text
refund_request_outbox (lease, attempts, backoff)
  -> adapter sandbox dipanggil DI LUAR transaksi/lock
  -> refund_provider_events (dedupe provider + event_id)
  -> hanya status 'succeeded':
        debit system 'orders.payment.escrow' -> kredit wallet buyer
        (WalletService.postTransfer, idempotency 'refunds.sandbox.credit:<refundId>')
        set succeeded + succeeded_at + ledger_transaction_id
        audit + outbox notifikasi buyer
  -> 'failed'  : failed_at + last_error, TANPA kredit (retry/backoff; permanen -> needs_assistance)
  -> 'pending' : tetap menunggu, TANPA kredit
```

## Invariant yang dijaga database

- `refunds_one_per_order_uq` (partial unique): satu refund _live_ atau _succeeded_ per order → refund kedua ditolak DB (dipetakan ke `409 REFUND_ALREADY_EXISTS` sebagai pertahanan terakhir; jalur HTTP normal ditolak lebih dulu oleh `ORDER_CANCEL_CONFLICT`). Refund berstatus `failed` tidak menghalangi percobaan baru.
- `refunds_succeeded_check`: `succeeded_at` dan `ledger_transaction_id` hanya boleh terisi saat status `succeeded`.
- `refunds_failed_check`: `failed_at` hanya saat status `failed`.
- `refunds_amount_check` / `refunds_currency_check`: amount integer > 0, currency IDR.
- FK komposit `(tenant_id, order_id) -> orders`, `(order_id, order_payment_id) -> order_payments(order_id, id)`, `(tenant_id, case_id) -> cases(tenant_id, id)` → refund tidak dapat menunjuk order/pembayaran/kasus milik tenant lain.
- `refund_provider_events_provider_event_uq`: replay callback provider tidak dapat mengkredit dua kali.
- `cases_decision_check`: `decided_at`/`decided_by_user_id`/`decision_reason` wajib hanya untuk status terminal (`approved_cancel`/`declined`/`resolved`) dan NULL untuk status lain.

## Kode error kontrak

### Kode yang dapat diterima klien HTTP

Refunds: `REFUNDS_PROVIDER_DISABLED` (503 saat mode `disabled`), `REFUND_REASON_REQUIRED` (400), `ORDER_PAYMENT_NOT_REFUNDABLE` (409), `REFUND_CURRENCY_UNSUPPORTED` (409), `REFUND_ALREADY_EXISTS` (409), `REFUND_STATE_CONFLICT`/`REFUND_REFERENCE_CONFLICT` (409, hanya dari pemrosesan internal yang dipanggil lewat jalur HTTP lain).

Cases: `CASE_STATUS_INVALID`, `CASE_REASON_REQUIRED`, `CASE_ORDER_REQUIRED`, `CASE_CATEGORY_INVALID`, `CASE_SUBJECT_INVALID`, `CASE_DETAILS_TOO_LONG` (400); `CASE_ALREADY_DECIDED`, `CASE_STATE_CONFLICT` (409); `REFUNDS_PROVIDER_DISABLED` (503, lihat batasan di bawah).

Catatan ketepatan kontrak (review F10):

- `REFUND_LEASE_LOST` adalah kode **internal/audit**, bukan kode HTTP. Kode ini dilempar `fenceOutboxDone` di dalam transaksi saat lease outbox sudah diambil worker lain, lalu ditelan menjadi hasil `{ outcome: 'skipped', reason: 'lease_lost' }` oleh processor. Klien tidak pernah menerimanya dan tidak perlu menanganinya.
- `REFUND_ALREADY_EXISTS` praktis tidak terjangkau lewat `POST /v1/campuses/:campusId/refunds`: keputusan kedua ditolak lebih dulu oleh orders slice dengan `409 ORDER_CANCEL_CONFLICT` karena order sudah `cancelled`. Mapping `23505 refunds_one_per_order_uq` dipertahankan sebagai pertahanan terakhir (mis. balapan dengan jalur lain), bukan sebagai jalur yang dijanjikan.
- `ORDER_CANCEL_CONFLICT` berasal dari orders slice (bukan kode milik modul ini) dan muncul untuk order terminal (`completed`/`cancelled`/`declined`).

## Keputusan dan batasan

- **Refund penuh saja.** Refund parsial belum diputuskan produknya; permintaan parsial ditolak, bukan dipotong diam-diam.
- **Provider hanya sandbox.** `REFUNDS_PROVIDER_MODE` = `disabled` (default, wajib di production) atau `sandbox` untuk pengujian. Tidak ada endpoint webhook refund pada wave ini: adapter bersifat _processor-driven_ dan hasilnya dicatat sebagai `refund_provider_events`. Adapter QRIS/Midtrans produksi butuh kontrak, kredensial, dan rekonsiliasi tersendiri.
- **Kredit hanya lewat ledger.** Modul ini tidak menulis `ledger_entries` langsung; semua perpindahan dana lewat `WalletService.postTransfer` dengan akun system `orders.payment.escrow` (D16.1). Bukti test mengassert transaksi ledger refund itu sendiri: tepat 2 entri seimbang, `debit.account_id` = akun `orders.payment.escrow`, `credit.account_id` = wallet buyer, `sum(debit) = sum(credit) = amount_minor` (tanpa memakai saldo absolut akun system yang dipakai bersama).
- **Kasus setelah pickup** tidak dapat menghasilkan `approved_cancel`; keputusan terminal lain tetap boleh dicatat sebagai hasil tinjauan manusia.
- **`approved_cancel` MUSTAHIL saat provider disabled (default dan satu-satunya nilai sah di production).** Keputusan `approved_cancel` membuat refund lewat `RefundsService.initiateCancellationRefund` di transaksi yang sama; selama `REFUNDS_PROVIDER_MODE != 'sandbox'` pemanggilan itu melempar `503 REFUNDS_PROVIDER_DISABLED` dan **seluruh keputusan di-rollback** (status kasus, order, reservasi, audit, dan outbox tidak berubah). Jadi di production pengelola kampus belum dapat menyetujui pembatalan+refund sama sekali; ini konsekuensi yang disengaja dari "refund hanya setelah provider aktif", bukan bug. Endpoint tetap mengembalikan 503 yang jelas dan tercatat di OpenAPI.
- **Provider disabled = kegagalan PERMANEN, bukan transien.** Refund yang dibuat saat sandbox aktif lalu provider dimatikan diparkir pada percobaan **pertama** (`needs_assistance` + `last_error = REFUNDS_PROVIDER_DISABLED`, outbox `dead`, `attempts = 1`), bukan di-retry 5 kali dengan backoff. Adapter melempar `PermanentRefundRequestError` untuk kondisi konfigurasi ini.
- **Pembukaan kasus berjalan dalam satu transaksi.** `loadOrderScope` membaca scope order dengan `FOR SHARE` di dalam transaksi yang sama dengan `INSERT cases` (dan pemeriksaan permission ikut memakai `PoolClient` itu), sehingga pembatalan/refund yang berjalan bersamaan tidak dapat menyelip di antara validasi dan insert (menutup TOCTOU). Keputusan `approved_cancel` dan pembatalan order memakai `FOR UPDATE` pada baris order yang sama, jadi keduanya terserialisasi.
- **Timestamp respons = string mikrodetik dari DB (D7).** `requestedAt`/`submittedAt`/`succeededAt`/`failedAt`/`createdAt`/`updatedAt` (refunds) dan `decidedAt`/`createdAt`/`updatedAt` (cases) dikembalikan lewat `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, bukan `Date.toISOString()`. Cursor pagination memakai nilai yang sama. Belum ada endpoint di modul ini yang menerima `expectedUpdatedAt`, tetapi bentuk mikrodetik ini wajib dipertahankan bila kelak ditambahkan.
- **`needs_assistance` belum punya jalur penyelesaian (pekerjaan produk terbuka).** Tidak ada endpoint admin, job rekonsiliasi, maupun transisi `needs_assistance -> processing/succeeded`; saat ini penyelesaian hanya lewat SQL manual dan karenanya tidak berjejak audit di aplikasi. Ini dana yang butuh bantuan manusia (PILOT-POLICY bagian Transaksi), sehingga penyelesaiannya wajib menjadi pekerjaan berikutnya: endpoint dengan permission khusus + audit, atau job rekonsiliasi yang mencatat hasilnya. `markNeedsAssistance` sendiri hanya dipanggil processor.
- **Job pembersih** outbox/idempotency yang sudah selesai belum ada (pekerjaan operasional).
- **Wiring queue** dimiliki root: `REFUND_REQUESTS_QUEUE = 'refund-requests'` didaftarkan di `src/jobs/jobs.module.ts` dan `RefundRequestDispatcher`/`RefundRequestProcessor` dipasang di `src/worker.module.ts`. Perilakunya sekarang dijaga test: jobId memuat nonce (`updated_at` mikrodetik) sehingga berubah setiap siklus lease, job yang gagal terminal dihapus lalu di-enqueue ulang, baris due > 120 detik memicu alarm log, dan payload job yang tidak sah langsung `UnrecoverableError`.

## Pengujian

- `test/refunds.spec.ts` — 20 test PostgreSQL: keputusan berizin membuat order cancelled + refund pending + outbox **tanpa** kredit; kredit tepat sekali setelah provider sukses (ledger 2 entri seimbang, **debit dari `orders.payment.escrow`** dan kredit ke wallet buyer, tanpa saldo absolut); replay provider event tidak menggandakan; **dua worker paralel** (lease kedaluwarsa, dan varian keduanya masuk jalur sukses) tetap menghasilkan tepat satu kredit, satu `refund_provider_events`, dan satu transisi `succeeded`; failed/pending tanpa kredit; refund kedua 409; **refund untuk order tanpa pembayaran ditolak 409 `ORDER_PAYMENT_NOT_REFUNDABLE` tanpa efek samping**; CHECK/UNIQUE `refunds_*` (succeeded tanpa ledger/succeeded_at, failed tanpa failed_at, arah sebaliknya, amount 0/pecahan, currency non-IDR, reason kosong, satu refund live per order); scope lintas kampus 404; mode disabled menolak di HTTP dan **memarkir refund pada percobaan pertama** (`needs_assistance`, `attempts = 1`); timestamp respons berbentuk mikrodetik dari DB.
- `test/cases.spec.ts` — 19 test PostgreSQL: pembukaan kasus per peran, transisi status, keputusan `approved_cancel` memicu refund pending dalam transaksi yang sama, double decision 409, kasus setelah pickup tidak memicu refund, CHECK DB menolak kombinasi status/waktu keputusan, scoping list/detail, timestamp mikrodetik, dan pembukaan kasus tidak menyelip di tengah pembatalan order yang berjalan bersamaan.
- `test/refunds-http.spec.ts` / `test/cases-http.spec.ts` — kontrak transport seluruh 13 route (3 refunds + 10 cases) tanpa database (Test + Fastify + `ValidationPipe` whitelist/forbidNonWhitelisted/transform seperti `src/main.ts`): 401 tanpa bearer di semua route, 403/404/409/503 dengan kode stabil, 400 untuk field asing (`amountMinor`, `status`, `buyerId`, `tenantId`), UUID salah, reason/subject kosong, enum salah, query list tidak sah, plus envelope `{data, meta}`, status 201/200, dan pembuktian bahwa principal sesi (`userId`) benar-benar diteruskan ke service di setiap route.
- `test/refunds-queue.spec.ts` — wiring BullMQ dengan Redis nyata: payload job tidak sah -> `UnrecoverableError` tanpa menyentuh domain; nonce jobId berubah saat baris berubah; baris due > 120 detik memicu alarm; job gagal terminal dihapus dan baris di-enqueue ulang sampai selesai.
