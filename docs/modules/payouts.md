# Modul Payouts + Rekening Bank

Slice ini menangani **rekening payout tenant** (terenkripsi, tersamarkan) dan **pencairan (payout)**
dari payable tenant ke rekening terverifikasi. Skema sudah ada di migrasi `0009`
(`src/database/schema/payouts.ts`) dan tidak diubah oleh modul ini. Desain:
[docs/design/settlement-payout.md](../design/settlement-payout.md) §2–§6; keputusan root:
[docs/reviews/wave1-decisions.md](../reviews/wave1-decisions.md) D18 (Q1–Q10 final).

Aturan yang dipegang (AGENTS.md, docs/PILOT-POLICY.md, REQUIREMENTS §3.8):

- hanya **pemilik tenant terverifikasi** yang dapat mengelola rekening dan mengajukan payout;
  staf dapur/pengambilan **tidak** (403 di mesin akses, bukan hanya di UI);
- payout **sandbox** saja; production selalu `disabled` (`503 PAYOUT_PROVIDER_DISABLED`);
- dana **di-hold atomik** saat request; sukses/gagal memindahkan atau melepas hold **tepat sekali**;
- tidak ada persetujuan kampus per payout, tidak ada jadwal batch otomatis;
- nomor rekening **tidak pernah** disimpan plaintext dan tidak pernah keluar dari server (masking);
- tidak ada fee/komisi/pajak pada pilot (tidak ada kolom fee/net).

## Endpoint

Semua route `/v1/tenants/:tenantId/...` memerlukan bearer token; `tenantId` dari **path**.

| Method | Path                                              | Permission                   | Catatan                                             |
| ------ | ------------------------------------------------- | ---------------------------- | --------------------------------------------------- |
| GET    | `/v1/tenants/:tenantId/bank-accounts`             | `tenant.bank_account.manage` | selalu tersamarkan; filter `status`                 |
| POST   | `/v1/tenants/:tenantId/bank-accounts`             | `tenant.bank_account.manage` | baris baru: status `active`, verifikasi `pending`   |
| POST   | `/v1/tenants/:tenantId/bank-accounts/:id/replace` | `tenant.bank_account.manage` | baris baru + baris lama `disabled`                  |
| DELETE | `/v1/tenants/:tenantId/bank-accounts/:id`         | `tenant.bank_account.manage` | `disabled` (tidak dihapus), idempoten               |
| POST   | `/v1/tenants/:tenantId/bank-accounts/:id/verify`  | `tenant.bank_account.manage` | **503 `BANK_ACCOUNT_VERIFICATION_DISABLED`** (Q4)   |
| POST   | `/v1/tenants/:tenantId/payouts`                   | `tenant.payout.request`      | wajib `Idempotency-Key`; hold atomik                |
| GET    | `/v1/tenants/:tenantId/payouts`                   | `tenant.finance.read`        | cursor; filter `status`                             |
| GET    | `/v1/tenants/:tenantId/payouts/:payoutId`         | `tenant.finance.read`        | payout + timeline + alokasi settlement              |
| POST   | `/v1/tenants/:tenantId/payouts/:payoutId/cancel`  | `tenant.payout.request`      | hanya status `requested`                            |
| GET    | `/v1/campuses/:campusId/payouts`                  | `campus.payouts.read`        | **read-only** pemantauan kampus, selalu tersamarkan |

`POST /v1/tenants/:tenantId/payouts` membalas `{ data, meta: { replayed } }`: `meta.replayed=true`
berarti request itu memutar ulang `Idempotency-Key` yang sama (tidak ada hold kedua), bukan payout baru
(F7).

`AccessService.requireTenant` menolak semua role selain `owner` untuk ketiga permission finansial,
jadi staf kitchen/pickup menerima **403** walaupun permission-nya diberikan manual. Rekening milik
tenant lain -> **404** (bukan 403, tanpa kebocoran keberadaan).

## Pemantauan kampus (F9, REQUIREMENTS §3.8.7)

`GET /v1/campuses/:campusId/payouts` memberi pengelola kampus pandangan **baca saja** atas payout
tenant di kampusnya (`campus.payouts.read`): `payoutId`, `tenantId`, `tenantName`, `status`,
`amountMinor`, `currency`, `bankCode`, `accountNumberMasked`, dan timestamp status. Cursor + filter
`status` sama seperti daftar tenant.

- Scope kampus **diturunkan server-side** dari `tenants.campus_id` di dalam query, bukan dari body;
  kampus lain -> 403 dari `AccessService.requireCampus`.
- Tidak ada route kampus yang meminta, menyetujui, membatalkan, atau mengganti tujuan payout - controller
  ini hanya punya handler `GET` (`test/payouts-http.spec.ts`, `test/payouts-di.spec.ts`).
- Nomor rekening penuh, ciphertext, dan hash tidak pernah ikut: hanya bentuk tersamarkan.
- `GET /v1/campuses/:campusId/settlements` (`campus.transactions.read`) **belum** dibuat - lihat
  [settlements.md](settlements.md) bagian "Ditunda".

## Rekening bank

### Penyimpanan dan masking

| Kolom                       | Isi                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `account_number_ciphertext` | AES-256-GCM dengan `AUTH_ENCRYPTION_KEY` (base64: iv + tag + ciphertext), pola yang sama dengan pickup/auth |
| `account_number_hash`       | HMAC-SHA256 berkunci (kunci diturunkan dari kunci enkripsi) untuk deteksi duplikat                          |
| `account_number_masked`     | `****1234` - satu-satunya bentuk yang boleh keluar di API/log                                               |

HMAC (bukan hash polos) dipakai karena nomor rekening berentropi rendah sehingga hash tanpa kunci
dapat dibalik dengan enumerasi. Kunci hilang/format salah -> **503 `BANK_ACCOUNT_ENCRYPTION_DISABLED`**
(fail closed), bukan menyimpan data tanpa perlindungan. Dekripsi hanya dilakukan processor payout,
**di luar** transaksi/lock, dan hasilnya tidak pernah dicatat.

### Perubahan rekening = baris baru

`replace` menonaktifkan baris lama (`status='disabled'`, `is_default=false`) lalu membuat baris baru
`verification_status='pending'`. Tidak ada UPDATE in-place dan tidak ada penghapusan, sehingga histori
audit utuh dan **payout lama tetap menunjuk snapshot tujuannya** (`bank_code`, `account_number_masked`,
`account_holder_name` disimpan pada baris payout saat request). Nomor yang sama boleh didaftarkan lagi
setelah baris lama dinonaktifkan (partial unique hanya untuk `status='active'`).

### Verifikasi (Q4 - DITUNDA)

Mekanisme verifikasi (provider name-match vs verifikasi manual kampus) belum diputuskan, sehingga
endpoint `verify` **tidak diaktifkan** dan mengembalikan `503 BANK_ACCOUNT_VERIFICATION_DISABLED`.
Otorisasi tetap dijalankan lebih dulu, jadi staf tetap menerima 403, bukan 503 yang menyesatkan.
Rekening dapat menjadi `verified` hanya melalui jalur terkontrol **service-only**
`BankAccountsService.markVerified(client, tenantId, accountId, { verifiedByUserId, method })` yang
menulis audit `tenant.bank_account.verified`; jalur ini tidak diekspos ke HTTP. Payout hanya boleh ke
rekening `status='active'` **dan** `verification_status='verified'`; selain itu
`409 PAYOUT_BANK_ACCOUNT_UNVERIFIED`.

Pertahanan berlapis (F8):

- **Otorisasi lebih dulu.** `createBankAccount`/`replaceBankAccount` memanggil
  `requireTenant('tenant.bank_account.manage')` **sebelum** normalisasi dan enkripsi, sehingga
  bukan-anggota menerima **403**, bukan 400 (input tidak sah) atau 503 (`AUTH_ENCRYPTION_KEY` hilang).
  Jalur kripto tidak pernah berjalan untuk pemanggil tak berwenang.
- **`markVerified` menolak rekening non-`active`** dengan `409 BANK_ACCOUNT_NOT_ACTIVE` (row dikunci
  `FOR UPDATE`), supaya `verification_status` tidak pernah bertentangan dengan `status` (mis.
  rekening yang sudah dinonaktifkan tidak bisa "terverifikasi").

## Alur payout

```text
POST /payouts (Idempotency-Key wajib)
  -> SATU transaksi:
       1. requireTenant('tenant.payout.request')
       2. payoutId = UUIDv5(sha1) dari (tenantId, Idempotency-Key)  -> replay terdeteksi tanpa kolom baru
          - sudah ada + input sama  : kembalikan payout (replayed), TANPA hold kedua
          - sudah ada + input beda  : 409 PAYOUT_IDEMPOTENCY_REUSED
       3. rekening: harus milik tenant (404 bila bukan) + active + verified (409)
       4. tolak 409 PAYOUT_ACTIVE_EXISTS bila ada payout requested/processing
       5. lock akun payable (FOR UPDATE), banding BigInt amount <= saldo (409 bila kurang)
       6. postTransfer: debit tenant.payable.<t> -> kredit tenant.payout.hold.<t>
            idempotency 'payouts.hold:<payoutId>', reference 'payout_hold'
       7. INSERT payouts (status 'requested', snapshot tujuan) + payout_request_outbox
          + payout_events + audit 'tenant.payout.requested' + outbox 'payout.status_changed'

processor (worker, di luar transaksi/lock saat memanggil adapter):
  lease payout_request_outbox (attempts++, lease 60s)
  -> requested -> processing (transaksi terpisah, sebelum provider dipanggil)
  -> adapter sandbox submitPayout(...)   [TANPA transaksi/row lock]
  -> sukses  : dedupe payout_provider_events -> postTransfer hold -> payout.clearing
                ('payouts.settle:<payoutId>', reference 'payout_settle')
                -> alokasi FIFO ke settlements -> status 'succeeded' + settle_ledger_transaction_id
  -> gagal   : dedupe event -> postTransfer hold -> payable
                ('payouts.release:<payoutId>', reference 'payout_release')
                -> status 'failed' + release_ledger_transaction_id
  -> permanen: SAMA dengan gagal (hold kembali ke payable, status 'failed'), TANPA retry
  -> ambigu  : attempt 'unknown', hold TETAP dipegang, outbox 'dead', payout tetap 'processing'
```

### Kegagalan permanen vs transien (F3)

`PermanentPayoutRequestError` berarti "mencoba ulang tidak akan pernah berhasil": processor menandai
attempt `failed`, menulis event/audit `tenant.payout.failed`, **melepas hold kembali ke payable**, dan
menutup outbox sebagai `done`. Payout berakhir `failed` (bukan `processing`), jadi
`payouts_one_active_per_tenant_uq` tidak lagi memblokir request berikutnya.

`SandboxPayoutAdapter` melempar error permanen untuk `PAYOUT_PROVIDER_DISABLED` (mode `disabled` atau
`NODE_ENV=production`). Sebelumnya kondisi deterministik ini diklasifikasikan transien sehingga payout
menghabiskan 5 percobaan lalu `needs_assistance` dengan dana tertahan; sekarang tepat **satu** attempt
dan uang kembali ke payable. Kegagalan transien (jaringan/timeout) tetap memakai backoff, dan hasil
**ambigu** tetap menahan dana (D18 Q9). Diuji `test/payouts.spec.ts`.

Status: `requested` -> `processing` -> `succeeded` (terminal) | `failed` (terminal);
`requested` -> `cancelled` (terminal, hold dilepas). Transisi ilegal -> `409 PAYOUT_STATE_CONFLICT`
(mis. cancel setelah `processing`, D18 Q9).

### Alokasi FIFO ke settlement

Saat sukses, payout mengalokasikan dananya ke settlement `available` tenant, urut
`released_at, id` (paling lama dulu), boleh memotong settlement terakhir:

- `payout_allocations` (+ UNIQUE `(payout_id, settlement_id)`),
- `settlements.paid_out_minor += take`, dan status menjadi `paid_out` bila sudah penuh,
- bila total settlement tidak menutup `payouts.amount_minor` -> **409
  `PAYOUT_ALLOCATION_MISMATCH`** dan seluruh transaksi settle di-rollback (uang tetap di hold).

### "Tepat sekali" berlapis

1. `UPDATE payouts ... WHERE status='processing'` + `rowCount = 1` (0 = sudah ditangani, no-op);
2. CHECK `payouts_ledger_legs_check`: satu leg terminal per payout (`settle` XOR `release`);
3. ledger idempoten (`idempotency_scope + key`) dan `reference` unik global -> posting ulang
   mengembalikan transaksi yang sama;
4. `payout_provider_events` UNIQUE `(provider, event_id)` -> replay hasil provider tidak memindahkan
   dana dua kali;
5. lease/fencing pada `payout_request_outbox` -> worker lain tidak dapat menutup pekerjaan yang sama.

## Akun ledger

| Peristiwa       | Debit                    | Kredit                   | Idempotency       | Reference        |
| --------------- | ------------------------ | ------------------------ | ----------------- | ---------------- |
| Request (hold)  | `tenant.payable.<t>`     | `tenant.payout.hold.<t>` | `payouts.hold`    | `payout_hold`    |
| Sukses (settle) | `tenant.payout.hold.<t>` | `payout.clearing`        | `payouts.settle`  | `payout_settle`  |
| Gagal/batal     | `tenant.payout.hold.<t>` | `tenant.payable.<t>`     | `payouts.release` | `payout_release` |

Tiga namespace berbeda wajib: `(reference_namespace, reference_id)` unik **global** pada
`ledger_transactions`, jadi satu namespace `payout` akan menggagalkan leg kedua dengan 409.

## Invariant yang dijaga database

- `payouts_one_active_per_tenant_uq` (partial unique): satu payout `requested`/`processing` per tenant.
- `payouts_ledger_legs_check`: `hold_ledger_transaction_id` selalu ada; `succeeded` ->
  `settle_ledger_transaction_id` saja; `failed`/`cancelled` -> `release_ledger_transaction_id` saja;
  `requested`/`processing` -> keduanya NULL.
- `payouts_timestamps_check` (bidireksional) dan `payouts_amount_check`/`payouts_currency_check`.
- `payouts_provider_reference_uq` (parsial) untuk dedupe referensi provider.
- `bank_accounts_one_default_uq`, `bank_accounts_tenant_number_uq` (parsial `active`),
  `bank_accounts_verification_check` (verified <-> `verified_at`/`verified_by_user_id`/`method`),
  `bank_accounts_hash_check` (`^[a-f0-9]{64}$`).
- `payout_allocations` FK komposit `(tenant_id, payout_id)` dan `(tenant_id, settlement_id)`:
  alokasi tidak dapat menyeberang tenant.
- `payouts.bank_account_id` **hanya FK tunggal** ke `bank_accounts(id)` (F4). Desain §2.3 menyebut FK
  komposit `(tenant_id, bank_account_id) -> bank_accounts(tenant_id, id)`, dan unique
  `bank_accounts_tenant_id_id_uq` sudah ada sebagai targetnya, tetapi migrasi 0009 belum memakainya.
  Konsekuensi: database **tidak** mencegah baris `payouts` menunjuk rekening tenant lain; isolasi
  ditegakkan service (query rekening selalu `where id = $1 and tenant_id = $2`, ditambah pemeriksaan
  ulang `tenant_id` pada baris hasil). FK komposit ditambahkan pada **migrasi berikutnya** (milik root);
  perubahan schema tidak boleh dilakukan slice ini. Diuji `test/payouts.spec.ts`.
- `payout_attempts_payout_attempt_uq` + `payout_attempts_finished_check`;
  `payout_provider_events_provider_event_uq`; `payout_events_payout_version_uq` + `actor` XOR CHECK.

Tidak dapat dijaga DB (dijaga service + test PostgreSQL): saldo payable/hold tidak negatif
(`wallet_accounts_balance_nonnegative_check` hanya untuk `account_type='wallet'`), dan
`SUM(payout_allocations) = payouts.amount_minor` per payout.

## Kode error kontrak

| Kode                                 | HTTP | Arti                                                    |
| ------------------------------------ | ---- | ------------------------------------------------------- |
| `PAYOUT_PROVIDER_DISABLED`           | 503  | mode `disabled` (selalu di production)                  |
| `PAYOUT_NEEDS_ASSISTANCE`            | -    | internal: hasil ambigu, dana tetap di hold (audit)      |
| `PAYOUT_AMOUNT_INVALID`              | 400  | `amountMinor` bukan integer minor string > 0            |
| `PAYOUT_IDEMPOTENCY_KEY_INVALID`     | 400  | header tidak ada / bukan 8..200 karakter `A-Za-z0-9._:` |
| `PAYOUT_AMOUNT_EXCEEDS_AVAILABLE`    | 409  | saldo payable < amount                                  |
| `PAYOUT_ACTIVE_EXISTS`               | 409  | masih ada payout `requested`/`processing`               |
| `PAYOUT_BANK_ACCOUNT_UNVERIFIED`     | 409  | rekening tidak `active` + `verified`                    |
| `PAYOUT_IDEMPOTENCY_REUSED`          | 409  | key sama, input berbeda                                 |
| `PAYOUT_STATE_CONFLICT`              | 409  | transisi ilegal (mis. cancel setelah `processing`)      |
| `BANK_ACCOUNT_VERIFICATION_DISABLED` | 503  | endpoint verifikasi dimatikan (Q4)                      |
| `BANK_ACCOUNT_ENCRYPTION_DISABLED`   | 503  | `AUTH_ENCRYPTION_KEY` tidak ada/format salah            |
| `BANK_ACCOUNT_NUMBER_INVALID`        | 400  | nomor bukan 6..20 digit setelah normalisasi             |
| `BANK_ACCOUNT_BANK_UNSUPPORTED`      | 400  | kode bank di luar allowlist pilot                       |
| `BANK_ACCOUNT_HOLDER_INVALID`        | 400  | nama pemilik kosong/>200                                |
| `BANK_ACCOUNT_ALREADY_EXISTS`        | 409  | rekening aktif yang sama sudah terdaftar                |
| `BANK_ACCOUNT_NOT_ACTIVE`            | 409  | hanya rekening aktif yang bisa di-replace               |
| `PAYOUT_ALLOCATION_MISMATCH`         | -    | internal: settle di-rollback (uang tetap di hold)       |

## Wiring queue (milik ROOT)

Modul ini **tidak** mendaftarkan queue (agar app HTTP boot tanpa Redis queue), mengikuti pola refunds:

| Yang perlu dipasang root | Nilai                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue                    | `PAYOUT_REQUESTS_QUEUE = 'payout-requests'`                                                                                                                                     |
| Job name                 | `PAYOUTS_QUEUE_JOB_NAME = 'request'`                                                                                                                                            |
| Dispatcher               | `PayoutRequestDispatcher` (`src/modules/payouts/payout-request.processor.ts`)                                                                                                   |
| Processor                | `PayoutRequestProcessor` (queue yang sama)                                                                                                                                      |
| Registrasi               | `BullModule.registerQueue({ name: PAYOUT_REQUESTS_QUEUE })` di `src/jobs/jobs.module.ts`, keduanya sebagai provider di `src/worker.module.ts` dengan `imports: [PayoutsModule]` |
| Env                      | `PAYOUTS_PROVIDER_MODE` (`disabled`                                                                                                                                             | `sandbox`, production hanya `disabled`) - sudah ada di `src/config/environment.ts` dan `.env.example` |

JobId dispatcher memuat attempt + nonce (`updated_at` mikrodetik), jadi stabil saat tidak ada perubahan
(dedupe antar tick) dan segar setiap siklus lease; job yang gagal terminal dihapus lalu baris
di-enqueue ulang; baris due > 120 detik memicu alarm log.

## Keputusan D18 dan batasan

- **Q4 verifikasi rekening: DITUNDA** -> endpoint 503; rekening hanya bisa `verified` lewat jalur
  service terkontrol. Tidak ada payout ke rekening yang belum terbukti.
- **Q5 batas nominal:** `amount > 0` dan `<= dana tersedia`; payout **parsial diizinkan**; tidak ada
  minimum/maksimum operasional.
- **Q6 penjaga DB saldo negatif: DITUNDA.** Service memakai lock + perbandingan `BigInt` + test
  konkurensi ("N payout paralel, dana cukup K -> tepat K sukses"). Trigger DB untuk
  `tenant.payable.%`/`tenant.payout.hold.%` = migrasi berikutnya (milik root).
- **Q8 fee tidak dimodelkan** - tidak ada kolom `fee_minor`/`net_minor`; biaya provider nyata adalah
  keputusan kontrak terpisah.
- **Q9 pembatalan saat `processing`: DITOLAK (409).** Provider sudah dipanggil.
- **Job penyapu / rekonsiliasi (Q7): ditunda** - payout `processing` dengan hasil ambigu tidak
  di-release otomatis; dana tetap di hold dan butuh rekonsiliasi manusia (audit
  `tenant.payout.needs_assistance`, outbox `dead`).
- **Provider sandbox saja**: adapter `SandboxPayoutAdapter` deterministik (selalu sukses, tanpa
  jaringan/uang nyata). Adapter bank/disbursement produksi butuh kontrak, kredensial, dan alur
  verifikasi tujuan.
- **Belum ada**: webhook payout (pemrosesan processor-driven), payout terjadwal/batch, notifikasi push
  payout (hanya outbox `payout.status_changed`), dan retensi bukti transfer.
- **FK komposit payout -> rekening (F4): DITUNDA ke migrasi berikutnya.** Schema milik root; untuk
  sementara isolasi tenant ditegakkan service + test (lihat "Invariant yang dijaga database").
- **`GET /v1/campuses/:campusId/settlements` (F9): DITUNDA**, lihat
  [settlements.md](settlements.md). Pemantauan payout kampus sudah ada.

## Pengujian

`test/payouts.spec.ts` (16 test PostgreSQL): hold tepat sebesar amount + jejak (outbox, event, audit,
snapshot tujuan); tolakan amount `0`/melebihi saldo, rekening pending, rekening tenant lain (404),
kitchen & pickup staff (403), dan mode `disabled`/production; satu payout aktif per tenant + replay
`Idempotency-Key` tidak menahan dana dua kali; **payout paralel** (6 request serentak per ronde, dana
cukup 3) -> tepat 3 sukses, payable/hold tidak pernah negatif; sukses memindahkan hold tepat sekali +
alokasi FIFO (termasuk potongan sebagian) + `paid_out_minor` konsisten + replay tidak menggandakan;
gagal melepas hold tepat sekali; hasil ambigu menahan dana dan menghentikan retry; cancel melepas hold
tepat sekali dan ditolak setelah `processing`; **adapter dipanggil di luar transaksi/lock** (dibuktikan
dengan `FOR UPDATE NOWAIT` dari koneksi lain); settle di-rollback saat alokasi tidak menutup amount;
snapshot tujuan tidak berubah setelah rekening diganti; **replay provider event tidak menggandakan**
(`(provider, event_id)` yang sama -> hasil `duplicate`, hold tetap utuh, tanpa leg settle); identitas
rekonsiliasi §4.4 (1)(2)(3); **mode provider dimatikan -> tepat satu attempt, hold dilepas, payout
`failed` dan request berikutnya tidak terblokir** (F3); rekening tenant lain tidak membuat payout/hold
dan tidak memindahkan uang (F4); pemantauan kampus `listCampusPayouts` (scope kampus, masking, 403
untuk kampus lain/permission lain, filter status) (F9).

`test/bank-accounts.spec.ts` (11 test PostgreSQL): enkripsi + HMAC (dekripsi kembali ke nomor asli,
hash bukan SHA-256 polos, tidak ada plaintext di baris), masking di semua respons, duplikat/kode bank
tidak dikenal/nomor tidak sah ditolak, replace = baris baru + baris lama disabled (default mengikuti),
disable idempoten tanpa menghapus, endpoint verifikasi 503, 403 untuk kitchen/pickup dan outsider,
404 lintas tenant, tidak ada ciphertext/hash di list, 503 saat kunci enkripsi hilang, `markVerified`
terkontrol + audit, **otorisasi sebelum kerja kripto** (bukan-anggota tetap 403 walau input tidak sah
dan kunci enkripsi hilang) dan **penolakan verifikasi rekening non-`active`** (F8).

`test/payouts-http.spec.ts` (14 test transport, tanpa DB): 401 di semua route, 201/200 + masking,
`Idempotency-Key` wajib & bentuknya divalidasi (400 tanpa memanggil service), 400 untuk amount/ID/field
asing, mapping 409/503/404/403 dengan kode stabil, list/detail/cancel, 403 staf, `meta.replayed` (F7),
serta blok terpisah untuk `GET /v1/campuses/:campusId/payouts` (401, masking + envelope cursor, 403/400,
dan tidak ada route kampus yang mutasi).

`test/payouts-queue.spec.ts` (2 test, Redis nyata): payload job tidak sah -> `UnrecoverableError` tanpa
menyentuh domain; jobId nonce berputar saat state baris berubah; baris due > 120 detik memicu alarm;
job yang gagal terminal dihapus lalu baris di-enqueue ulang dan payout selesai tepat sekali (F5).

`test/payouts-di.spec.ts` (2 test, tanpa DB/Redis): keempat modul (`PickupModule`, `CasesModule`,
`SettlementsModule`, `PayoutsModule`) di-boot bersama dan semua injeksi lintas slice terisi
(`forwardRef` settlements <-> cases resolve); route pemantauan kampus terdaftar sebagai `GET` dan
controller-nya tidak punya handler mutasi (F6/F9).

`test/schema-integrity-0009.spec.ts` (14 test PostgreSQL, lihat [settlements.md](settlements.md)):
constraint migrasi 0009 termasuk `payouts_one_active_per_tenant_uq`, `payouts_ledger_legs_check`,
`bank_accounts_verification_check`, `bank_accounts_hash_check`, `payout_allocations` UNIQUE + FK
komposit, `payout_provider_events`, `payout_attempts`, dan `payout_events`.
