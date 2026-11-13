# Modul Payments (top-up AntriPay — sandbox)

Slice `payments-impl` (task-4). Status: **sandbox/stub terkontrol**, belum ada provider uang nyata.
QRIS hanya untuk **top-up wallet buyer**; pembayaran order memakai wallet (slice lain). Tidak ada
endpoint yang memungkinkan klien mengkredit saldo secara langsung — saldo hanya bergerak lewat
`WalletService.postTransfer` (ledger double-entry) yang dipicu webhook provider tervalidasi.

Tabel milik slice ini: `topup_intents`, `payment_request_outbox`, `payment_provider_events`.
Slice ini **tidak** menulis `ledger_entries` langsung dan **tidak** mengubah wallet/audit/outbox/notifications.

## Konfigurasi (dimiliki root — src/config/environment.ts)

- `PAYMENTS_PROVIDER_MODE` = `disabled` | `sandbox`; production **hanya** `disabled`.
  Saat `disabled`, pembuatan intent dan webhook ditolak `503 PAYMENTS_PROVIDER_DISABLED` (tidak pura-pura sukses).
- `PAYMENTS_TOPUP_MIN_MINOR` (default 1000), `PAYMENTS_TOPUP_MAX_MINOR` (default 2000000) — batas inklusif integer minor IDR.
- `PAYMENTS_SANDBOX_WEBHOOK_SECRET` (>= 32 char, wajib saat sandbox) — kunci HMAC webhook.
- `PAYMENTS_SANDBOX_TOPUP_TTL_SECONDS` (integer 60..86400, default 3600) — umur `expires_at` intent top-up sandbox. Dibaca service via `ConfigService.getOrThrow` (konstanta `SANDBOX_TOPUP_TTL_SECONDS` = default/fallback untuk test).
- `rawBody: true` aktif di `src/main.ts` sehingga `req.rawBody` tersedia untuk verifikasi HMAC atas byte persis.

Batas min/max top-up (`PAYMENTS_TOPUP_MIN_MINOR`/`PAYMENTS_TOPUP_MAX_MINOR`) berasal dari config, bukan hardcode; production hanya mengizinkan `PAYMENTS_PROVIDER_MODE=disabled`.

Uang: integer satuan terkecil (IDR eksponen 0 = rupiah bulat) disimpan sebagai `numeric` di DB dan
ditransmisikan sebagai **string desimal** di JSON. Perbandingan memakai `BigInt`/SQL, tidak pernah `Number` (presisi).

## Endpoint

### Buyer (AuthGuard, principal `{userId}`)

- `POST /api/v1/me/wallet/topups` — buat (atau replay idempoten) intent top-up sandbox.
  - Body: `{ amountMinor: string, idempotencyKey: string }`. Field tak dikenal ditolak (whitelist + forbidNonWhitelisted global).
  - `amountMinor` pola `^(0|[1-9][0-9]*)$`, wajib dalam `[MIN, MAX]` (selain itu `400 TOPUP_AMOUNT_OUT_OF_BOUNDS` / `TOPUP_AMOUNT_INVALID`).
  - `idempotencyKey` pola `^[A-Za-z0-9_.:-]{8,200}$`, unik per user.
  - Dalam **satu transaksi PostgreSQL**: snapshot `wallet_account_id` milik user (`WalletService.getOrCreateWallet`),
    insert `topup_intents` (status `pending`, `expires_at = now()+TTL`), insert `payment_request_outbox` (status `pending`), append audit `topup.created`.
  - Replay kunci sama + payload sama -> mengembalikan intent yang sama (`replayed:true`) tanpa baris baru.
    Kunci sama + amount beda -> `409 TOPUP_IDEMPOTENCY_KEY_REUSED`. Insert bersamaan masih berjalan -> `409 TOPUP_IDEMPOTENCY_IN_PROGRESS` (retry klien aman).
  - `201` body `{ data: { id, provider, providerReference, amountMinor, currency, status, statusVersion, createdAt, updatedAt, expiresAt, succeededAt, qrisPayload, replayed } }`.
- `GET /api/v1/me/wallet/topups` — daftar intent milik pemanggil (cursor pagination `?limit&cursor`, `created_at desc, id desc`). Tidak membocorkan milik user lain.
- `GET /api/v1/me/wallet/topups/:id` — detail satu intent; intent milik user lain -> `404` (tidak dapat dibedakan dari tidak ada).

`qrisPayload` adalah string QRIS **tiruan** deterministik (prefix `ANTRIIN-QRIS-SANDBOX-v1|...`) yang hanya dihasilkan saat mode `sandbox` dan status `pending`.

### Webhook provider (server-to-server, HMAC — tanpa bearer)

- `POST /api/v1/webhooks/payments/:provider` — hanya `provider = 'sandbox'` (selain itu `404 WEBHOOK_PROVIDER_UNSUPPORTED`). `@HttpCode(200)`.
  - Header: `x-antriin-signature` (HMAC-SHA256 hex) dan `x-antriin-timestamp` (unix seconds), **terpisah**.
  - Signature dihitung atas string `timestamp + '.' + exactRawBody` dengan `PAYMENTS_SANDBOX_WEBHOOK_SECRET`.
  - Verifikasi (`src/modules/payments/webhook-signature.ts`):
    - header/rawBody hilang -> `401 WEBHOOK_CREDENTIALS_MISSING`;
    - timestamp non-integer -> `401 WEBHOOK_TIMESTAMP_INVALID`;
    - `|now - timestamp| > 300s` -> `401 WEBHOOK_TIMESTAMP_SKEW`;
    - signature tidak cocok (perbandingan **constant-time** `timingSafeEqual`) -> `401 WEBHOOK_SIGNATURE_INVALID`.
  - Body tervalidasi DTO `SandboxWebhookEventDto`: `{ eventId, reference, status(pending|succeeded|failed|expired), amountMinor, currency, occurredAt }`.
    `occurredAt` boleh historis (rekonsiliasi **late success**) dan **tidak** sama dengan timestamp autentikasi request.

  Alur `PaymentsService.handleProviderEvent(rawBody, dto)` dalam **satu transaksi**:
  1. `payloadHash = sha256(rawBody)`; `SELECT ... FROM topup_intents WHERE provider='sandbox' AND provider_reference = reference FOR UPDATE` (serialisasi per intent).
  2. Tidak ditemukan -> catat `payment_provider_events` (`outcome='unmatched'`, `topup_id NULL`), `422 PAYMENT_EVENT_UNMATCHED`, tanpa kredit.
  3. Korelasi **sebelum** mutasi: currency != intent -> mismatch; `BigInt(amount) != BigInt(intent.amount)` -> mismatch; intent `pending` -> applied; intent sudah berstatus sama -> duplicate; selain itu (mis. sukses vs gagal) -> mismatch `state`. Mismatch -> `422 PAYMENT_EVENT_MISMATCH`, tanpa kredit.
  4. Dedupe: `INSERT ... payment_provider_events (provider,event_id) ON CONFLICT DO NOTHING`. Bila konflik: `payload_hash` sama -> `duplicate` (200), beda -> `409 WEBHOOK_EVENT_CONFLICT`.
  5. Applied + `succeeded`: `ensureSystemAccount('payments.sandbox.topup-clearing')` sebagai debit, `postTransfer` kredit ke `wallet_account_id` intent (`idempotencyScope='payments.sandbox.webhook'`, `idempotencyKey='sandbox:'+eventId`, `reference={namespace:'topup_intent',id:intentId}`), lalu transisi status `pending->terminal` dengan guard `status_version` (+ `succeeded_at=now()` hanya untuk `succeeded`), append audit `topup.<status>`, dan `OutboxService.append` `topup.status_changed` (recipient = buyer). Semua dalam transaksi yang sama.
  6. `failed`/`expired`: transisi status tanpa kredit. `pending`: `outcome='ignored'`, tanpa perubahan.

  Kredit **tepat sekali**: dijaga oleh (a) `FOR UPDATE` per intent, (b) unique `(provider,event_id)`, (c) guard transisi `status='pending' AND status_version=?`, dan (d) idempotency + unique `reference` di ledger. Dua webhook paralel (event id sama atau berbeda) menghasilkan satu kredit.

## Processor request (BullMQ)

File `src/modules/payments/payment-request.processor.ts`. **Registrasi queue/worker milik root** (src/jobs + src/worker.module.ts).

- Konstanta queue: `PAYMENT_REQUESTS_QUEUE = 'payment-requests'`. Job name: `PAYMENTS_QUEUE_JOB_NAME = 'request'` (dari `payments.service.ts`).
- `PaymentRequestDispatcher` (OnApplicationBootstrap): polling `PaymentsService.listDuePaymentRequests()` tiap 1s dan `queue.add('request', {topupId}, {jobId: 'payment-request-<topupId>-<attempts>'})`. Tidak menahan lock DB saat berbicara ke Redis.
- `PaymentRequestProcessor extends WorkerHost`: memvalidasi bentuk job lalu memanggil `PaymentsService.processPaymentRequest(topupId)`.
- `processPaymentRequest`: lease baris (`pending` jatuh tempo ATAU `processing` dengan `lease_until` kedaluwarsa) via `UPDATE ... RETURNING` dengan `lease_token`/`lease_until` (fencing); **panggil adapter DI LUAR transaksi/lock**; lalu:
  - sukses + `providerReference` cocok -> `status='complete'` (lease dibersihkan) di bawah fencing `lease_token`;
  - `PermanentPaymentRequestError` -> `status='dead'` + `last_error_code`;
  - error transien -> kembali `pending` dengan **backoff eksponensial** (`available_at = now() + min(5*2^(attempts-1), 300)s`), atau `dead` bila `attempts >= MAX_PAYMENT_REQUEST_ATTEMPTS` (5);
  - `providerReference` tidak cocok / intent hilang -> `dead`.
    Retry tidak menggandakan efek finansial: sandbox adapter murni/deterministik dan tidak ada saldo yang bergerak di jalur request.

Wiring yang dibutuhkan root: `BullModule.registerQueue({ name: PAYMENT_REQUESTS_QUEUE })` di JobsModule; `WorkerModule` mengimpor `PaymentsModule` dan menambahkan `PaymentRequestDispatcher` + `PaymentRequestProcessor` sebagai provider (pola sama dengan OutboxDispatcher/OutboxProcessor).

## Adapter sandbox (stub terkontrol)

`src/modules/payments/payments.adapter.ts` — `SandboxPaymentsAdapter` (token `PAYMENTS_PROVIDER_ADAPTER`).
Fungsi murni deterministik, **tanpa jaringan nyata dan tanpa uang nyata**:

- `buildProviderReference` = `'sbx-' + sha256(userId|idempotencyKey|requestHash).slice(0,48)` (unik per intent).
- `renderQrisPayload` = string QRIS tiruan berlabel SANDBOX.
- `createPaymentRequest` mengonfirmasi referensi (melempar `PermanentPaymentRequestError` bila bentuk tak terduga).
- Menolak beroperasi saat `NODE_ENV='production'` (`503 PAYMENTS_PROVIDER_DISABLED`). Adapter Midtrans/QRIS produksi **tidak** dibuat (butuh provider/kontrak/kredensial nyata).

## Keputusan & asumsi

- TTL sandbox dibaca dari `PAYMENTS_SANDBOX_TOPUP_TTL_SECONDS` (default 3600; konstanta `SANDBOX_TOPUP_TTL_SECONDS` jadi default/fallback test). `expires_at` diisi saat insert (`now() + TTL`, memenuhi CHECK `expires_at > created_at`). **Expiry bersifat informasional**: tidak ada sweeper otomatis pada wave ini, sehingga intent yang lewat `expires_at` TETAP `pending` sampai ada event provider (`expired`/`failed`/`succeeded`) — status tidak berubah sendiri hanya karena umur.
- Route buyer memakai prefix `/me/wallet/topups` agar konsisten dengan `/me/wallet` yang sudah ada (bukan `/wallet/topups` literal di peta REQUIREMENTS-API, yang bersifat usulan transport).
- Akun system ledger `payments.sandbox.topup-clearing` menjadi sisi debit yang mendanai kredit top-up sandbox. **Sandbox-only**: akun/adapter ini tidak boleh dipakai di production (mode production hanya `disabled`; `SandboxPaymentsAdapter` menolak saat `NODE_ENV=production`). Provider QRIS/Midtrans nyata memerlukan akun clearing/kontrak terpisah.
- Sesuai D7: dedupe keuangan lewat unique constraint (`(user_id,idempotency_key)`, `(provider,provider_reference)`, `(provider,event_id)`), bukan timestamp. `updatedAt` dikembalikan apa adanya untuk tampilan; tidak ada optimistic-concurrency berbasis `expectedUpdatedAt` di slice ini.
- Sesuai D12 (0007, aditif): `topup_intents.expires_at`/`succeeded_at` nullable + CHECK; composite FK `(user_id, wallet_account_id) -> wallet_accounts(owner_user_id, id)` menolak kredit/tautan ke wallet user lain di level DB.

## Batasan (stub vs siap pakai)

- **Siap pakai (sandbox)**: intent + idempotency + outbox atomik, processor lease/retry/backoff/dead, webhook HMAC + dedupe + korelasi + kredit ledger tepat sekali + audit + outbox notifikasi, endpoint baca buyer ter-scope.
- **Stub/belum**: tidak ada provider QRIS/Midtrans nyata, tidak ada uang nyata, tidak ada expiry sweeper otomatis, `needs_assistance` belum dipakai, rekonsiliasi/alarm mismatch beyond pencatatan `payment_provider_events`.

## Test

- `test/payments.spec.ts` — PostgreSQL nyata: intent+outbox atomik & rollback, replay idempotency, reuse key beda amount, batas/non-integer IDR, mode disabled, production menolak sandbox, composite FK cross-user (23503), processor (complete/idempotent, dead permanen, defer backoff, cap attempts, lease fencing), webhook service-level (kredit tepat sekali + audit/outbox/ledger seimbang, dedupe, mismatch amount/currency/reference, late success, failed, pending ignored, dua webhook paralel event-id beda & sama).
- `test/payments-http.spec.ts` — HTTP (Fastify + `rawBody`): signature benar -> kredit; signature salah / timestamp basi / header hilang -> 401 tanpa kredit & tanpa event; provider tak didukung -> 404; buyer auth, forbidNonWhitelisted menolak field suntikan, list/detail ter-scope (404 lintas user), tidak ada route kredit langsung.

Menjalankan (Node 24, DB slice `antriin_payments`, migrasi 0006+0007 diterapkan):

```sh
export PATH=/Users/macbook/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH
export DATABASE_URL=postgresql://antriin_swarm:swarm_local_only@127.0.0.1:5544/antriin_payments
export TEST_DATABASE_URL="$DATABASE_URL" REDIS_HOST=127.0.0.1 REDIS_PORT=6381 TEST_REDIS_PORT=6381 CORS_ORIGINS=http://localhost:3001 NODE_ENV=test
npm run db:migrate
npx tsc -p tsconfig.test.json --outDir .test-dist-payments
node --test .test-dist-payments/test/payments.spec.js
node --test .test-dist-payments/test/payments-http.spec.js
```
