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

- `refunds_one_per_order_uq` (partial unique): satu refund _live_ atau _succeeded_ per order → refund kedua ditolak DB (dipetakan ke `409 REFUND_ALREADY_EXISTS`).
- `refunds_succeeded_check`: `succeeded_at` dan `ledger_transaction_id` hanya boleh terisi saat status `succeeded`.
- `refunds_failed_check`: `failed_at` hanya saat status `failed`.
- `refunds_amount_check` / `refunds_currency_check`: amount integer > 0, currency IDR.
- FK komposit `(tenant_id, order_id) -> orders`, `(order_id, order_payment_id) -> order_payments(order_id, id)`, `(tenant_id, case_id) -> cases(tenant_id, id)` → refund tidak dapat menunjuk order/pembayaran/kasus milik tenant lain.
- `refund_provider_events_provider_event_uq`: replay callback provider tidak dapat mengkredit dua kali.
- `cases_decision_check`: `decided_at`/`decided_by_user_id`/`decision_reason` wajib hanya untuk status terminal (`approved_cancel`/`declined`/`resolved`) dan NULL untuk status lain.

## Kode error kontrak

Refunds: `REFUNDS_PROVIDER_DISABLED` (503 saat mode `disabled`), `REFUND_REASON_REQUIRED`, `ORDER_PAYMENT_NOT_REFUNDABLE`, `REFUND_CURRENCY_UNSUPPORTED`, `REFUND_ALREADY_EXISTS`, `REFUND_STATE_CONFLICT`, `REFUND_REFERENCE_CONFLICT`, `REFUND_LEASE_LOST`.

Cases: `CASE_STATUS_INVALID`, `CASE_REASON_REQUIRED`, `CASE_ALREADY_DECIDED`, `CASE_ORDER_REQUIRED`, `CASE_STATE_CONFLICT`, `CASE_CATEGORY_INVALID`, `CASE_SUBJECT_INVALID`, `CASE_DETAILS_TOO_LONG`.

## Keputusan dan batasan

- **Refund penuh saja.** Refund parsial belum diputuskan produknya; permintaan parsial ditolak, bukan dipotong diam-diam.
- **Provider hanya sandbox.** `REFUNDS_PROVIDER_MODE` = `disabled` (default, wajib di production) atau `sandbox` untuk pengujian. Tidak ada endpoint webhook refund pada wave ini: adapter bersifat _processor-driven_ dan hasilnya dicatat sebagai `refund_provider_events`. Adapter QRIS/Midtrans produksi butuh kontrak, kredensial, dan rekonsiliasi tersendiri.
- **Kredit hanya lewat ledger.** Modul ini tidak menulis `ledger_entries` langsung; semua perpindahan dana lewat `WalletService.postTransfer` dengan akun system `orders.payment.escrow` (D16.1).
- **Kasus setelah pickup** tidak dapat menghasilkan `approved_cancel`; keputusan terminal lain tetap boleh dicatat sebagai hasil tinjauan manusia.
- **Job pembersih** outbox/idempotency yang sudah selesai belum ada (pekerjaan operasional).
- **Wiring queue** dimiliki root: `REFUND_REQUESTS_QUEUE = 'refund-requests'` didaftarkan di `src/jobs/jobs.module.ts` dan `RefundRequestDispatcher`/`RefundRequestProcessor` dipasang di `src/worker.module.ts`.

## Pengujian

- `test/refunds.spec.ts` — 14 test PostgreSQL: keputusan berizin membuat order cancelled + refund pending + outbox **tanpa** kredit; kredit tepat sekali setelah provider sukses (ledger seimbang, saldo benar); replay provider event tidak menggandakan; failed/pending tanpa kredit; refund kedua 409; refund untuk order tanpa pembayaran ditolak; scope lintas kampus 404; mode disabled menolak.
- `test/cases.spec.ts` — 17 test PostgreSQL: pembukaan kasus per peran, transisi status, keputusan `approved_cancel` memicu refund pending dalam transaksi yang sama, double decision 409, kasus setelah pickup tidak memicu refund, CHECK DB menolak kombinasi status/waktu keputusan, dan scoping list/detail.
