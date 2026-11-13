# Desain Slice Settlement + Payout + Rekening Bank

Status: **PROPOSAL DESAIN — dokumen saja**. Tidak ada kode, schema, migrasi, atau keputusan
finansial baru yang dibuat di sini. Disusun untuk keputusan root sebelum pekerjaan dipecah.

## 0. Cara membaca dokumen ini

Setiap butir diberi label:

- **[REQ]** = sudah mengikat di `docs/REQUIREMENTS-API.md`, `docs/PILOT-POLICY.md`, atau
  `docs/reviews/wave1-decisions.md` (D1–D17). Tidak boleh diubah agent.
- **[USULAN]** = usulan implementasi dokumen ini. Root bebas menerima/menolak.
- **[TANYA]** = aturan finansial/produk yang belum punya dasar; **tidak diputuskan di sini**,
  diajukan ke root di §9.

Sumber yang dibaca: `AGENTS.md`, REQUIREMENTS §3.8/§4/§6/§7, PILOT-POLICY butir transaksi &
otorisasi, D1–D17 (khusus D16 akun ledger, D4 satu-penulis, D7 timestamp, D10 permission, D12),
`src/database/schema/wallet.ts`, `orders.ts`, `cases.ts`, `refunds.ts`, `src/modules/wallet/wallet.service.ts`,
`docs/modules/orders.md`, `docs/modules/refunds-cases.md`, `docs/LEDGER.md`.

### 0.1 Ringkasan keputusan yang diminta root (detail di §9)

| #   | Pertanyaan                                                                   | Rekomendasi dokumen                                         |
| --- | ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Q1  | Akun payable per tenant atau satu akun global?                               | per tenant (`tenant.payable.<tenantId>`)                    |
| Q2  | Pemicu release: transaksi handover, event kasus selesai, atau job penyapu?   | handover + retry saat kasus ditutup; job penyapu = opsional |
| Q3  | Refund/chargeback setelah dana dirilis — clawback atau blokir?               | belum ada dasar; pilot: **blokir** (409), bukan clawback    |
| Q4  | Verifikasi rekening bank: provider name-match atau verifikasi manual kampus? | [TANYA] — wajib diputuskan sebelum endpoint payout aktif    |
| Q5  | Batas minimum/maksimum payout & boleh partial?                               | partial ≤ dana tersedia; min/max = [TANYA]                  |
| Q6  | Apakah payable/hold perlu trigger DB penolak saldo negatif (migrasi baru)?   | disarankan ya, tapi migrasi milik root                      |

## 1. Ruang lingkup & batasan

### 1.1 Yang dibutuhkan pilot [REQ]

1. **Dana pembayaran ditahan terpisah dari payable tenant.** Pembayaran sukses ≠ dana tersedia
   (REQUIREMENTS §1.2, §3.8.2; PILOT-POLICY butir 10).
2. **Release payable hanya setelah handover selesai DAN tidak ada kasus operasional terbuka.**
   Tidak ada release dari sekadar pembayaran sukses (PILOT-POLICY butir 10).
3. **Payout sandbox** diminta pemilik terverifikasi, ke rekening terverifikasi, maksimum dana
   tersedia dan harus positif. Dana **di-hold atomik saat request**; success/failure memindahkan/
   melepas hold **tepat sekali**. **Tanpa approval kampus per transaksi**. **Tidak ada jadwal batch
   otomatis** (PILOT-POLICY butir 13; REQUIREMENTS §3.8.7).
4. **Tanpa fee/komisi/pajak pilot**: tidak ada angka fee yang boleh dikarang (PILOT-POLICY butir 9).
   Karena itu model data pilot **tidak** memuat kolom fee/net; penambahannya menunggu kebijakan.
5. **Rekening bank hanya pemilik terverifikasi**; staf dapur/pengambilan tidak boleh melihat
   rekening sensitif, mengganti rekening, atau mengajukan payout (REQUIREMENTS §3.8.4, §2 tabel).
   Nomor rekening tidak disimpan plaintext; respons selalu tersamarkan (AGENTS.md, §7.6).
6. **Payout punya status & jejak**: diminta, diproses, berhasil, gagal; simpan jumlah, tujuan
   tersamarkan, referensi provider, kegagalan, waktu, riwayat (REQUIREMENTS §3.8.6).
7. **Semua perpindahan saldo lewat ledger double-entry** `WalletService.postTransfer`
   (AGENTS.md; `docs/LEDGER.md`).
8. **Pengelola kampus hanya memantau** payout (`campus.payouts.read`), bukan menyetujui
   (REQUIREMENTS §3.8.7).

### 1.2 Yang DITUNDA (jangan dikerjakan di slice ini) [USULAN]

| Ditunda                                                     | Alasan                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------- |
| Fee platform/MDR/pajak, net vs gross, pemotongan payout     | [REQ] pilot tanpa fee; tarif provider belum ada kontraknya    |
| Payout terjadwal/batch, payout otomatis, payout massal      | [REQ] PILOT-POLICY: tidak ada jadwal batch otomatis           |
| Payout production & provider bank nyata                     | [REQ] adapter sandbox/stub saja; production `disabled`        |
| Refund parsial, refund setelah release, clawback/chargeback | [REQ]/[TANYA] belum diputuskan produk                         |
| Rekonsiliasi otomatis dengan mutasi bank, laporan pajak     | pekerjaan operasional terpisah (REQUIREMENTS §12)             |
| Retensi/penghapusan data payout & rekening, rotasi kunci    | [TANYA] Q-retensi; kebijakan retensi belum ditetapkan         |
| Multi-currency, rekening non-IDR, payout lintas tenant      | [REQ] pilot IDR, satu tenant per payout                       |
| Notifikasi push payout ke tenant                            | outbox `payout.status_changed` sudah ada; kanal belum dipilih |

## 2. Model data usulan (belum migrasi) [USULAN]

Konvensi mengikuti yang sudah ada: UUID opaque, `timestamptz` UTC, uang `numeric` integer minor
dikembalikan sebagai string desimal, `updated_at` di-set eksplisit aplikasi (belum ada trigger),
satu penulis per tabel (D4). Migrasi berikutnya = `0009` (root yang membuat & menerapkan).

### 2.1 `settlements` — satu baris per order, catatan dana yang dirilis ke tenant

| Kolom                           | Tipe                       | Constraint / alasan                                                                            |
| ------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| `id`                            | uuid PK                    | opaque                                                                                         |
| `tenant_id`                     | uuid NOT NULL              | FK `tenants(id)` RESTRICT                                                                      |
| `order_id`                      | uuid NOT NULL              | **UNIQUE** (`settlements_one_per_order_uq`) — [REQ] satu settlement per order                  |
| `order_payment_id`              | uuid NOT NULL              | FK komposit `(order_id, order_payment_id) -> order_payments(order_id, id)` (pola refunds 0008) |
| `amount_minor`                  | numeric NOT NULL           | `> 0`, integer, `< 1e38` — jumlah payable yang dirilis (pilot = `order_payments.amount_minor`) |
| `currency`                      | varchar(3) NOT NULL        | `= 'IDR'`                                                                                      |
| `status`                        | varchar(16) NOT NULL       | `pending / available / paid_out / voided / reversed` (§4.1)                                    |
| `paid_out_minor`                | numeric NOT NULL default 0 | `>= 0`; CHECK keterkaitan dengan `status` (§2.5)                                               |
| `release_ledger_transaction_id` | uuid NULL                  | FK `ledger_transactions(id)` RESTRICT; terisi tepat saat `available`                           |
| `released_at`                   | timestamptz NULL           | hanya saat `available`/`paid_out`                                                              |
| `voided_at`, `reversed_at`      | timestamptz NULL           | hanya saat status terminal masing-masing                                                       |
| `created_at`, `updated_at`      | timestamptz NOT NULL       | `updated_at` di-set eksplisit                                                                  |

Constraint tambahan:

- FK komposit `(tenant_id, order_id) -> orders(tenant_id, id)` → settlement tidak bisa menunjuk
  order tenant lain (pola `refunds_tenant_order_fk`).
- `UNIQUE (tenant_id, id)` — target FK komposit untuk `payout_allocations` (pola D12.3).
- CHECK `settlements_status_timestamps_check` (bidirectional, pola `refunds_succeeded_check`):
  `status='available' AND released_at NOT NULL AND release_ledger_transaction_id NOT NULL`;
  `status='paid_out' AND released_at NOT NULL AND paid_out_minor = amount_minor`;
  `status='voided' AND voided_at NOT NULL AND paid_out_minor = 0`;
  `status='reversed' AND reversed_at NOT NULL AND paid_out_minor = 0`;
  `status='pending' AND released_at IS NULL AND release_ledger_transaction_id IS NULL`.
- CHECK `settlements_payout_amount_check`: `paid_out_minor <= amount_minor` dan
  `(status='paid_out' AND paid_out_minor = amount_minor) OR (status<>'paid_out' AND paid_out_minor < amount_minor)`.
- Indeks: `(tenant_id, status, released_at)`, `(status, released_at)` untuk sapuan retry,
  `(order_id)` sudah UNIQUE.

**Catatan kapan baris dibuat.** Pilot: baris lahir **saat release** dengan status `available`
(tidak ada baris `pending` yang dipersistensikan). Alasan: (a) tidak perlu menambah tulisan lintas
slice ke checkout yang sudah diterima, (b) ringkasan keuangan "pesanan terjadwal/belum selesai"
dapat diturunkan read-only dari `orders`/`order_payments`, (c) tidak ada state `pending` yang
bisa menggantung. Nilai `pending` tetap ada di CHECK agar kelak bisa dipakai bila produk ingin
mencatat settlement sejak pembayaran tanpa migrasi enum. [USULAN]

### 2.2 `payout_allocations` — payout mana membayar settlement mana

Dibutuhkan agar status `paid_out` punya bukti dan agar tenant/kampus bisa menelusuri
"payout X mencakup order A..N" (REQUIREMENTS §3.8.6 "riwayat", §7.5 indeks payout).

| Kolom           | Tipe             | Constraint                                                             |
| --------------- | ---------------- | ---------------------------------------------------------------------- |
| `id`            | uuid PK          |                                                                        |
| `tenant_id`     | uuid NOT NULL    | bagian dari dua FK komposit (integritas lintas tenant)                 |
| `payout_id`     | uuid NOT NULL    | FK komposit `(tenant_id, payout_id) -> payouts(tenant_id, id)`         |
| `settlement_id` | uuid NOT NULL    | FK komposit `(tenant_id, settlement_id) -> settlements(tenant_id, id)` |
| `amount_minor`  | numeric NOT NULL | `> 0`, integer                                                         |
| `created_at`    | timestamptz      |                                                                        |

- **UNIQUE (payout_id, settlement_id)** — satu settlement tidak dialokasikan dua kali ke payout yang
  sama (idempotensi alokasi).
- Alokasi ditulis **saat payout `succeeded`**, FIFO berdasarkan `settlements.released_at, id`,
  boleh memotong sebagian settlement terakhir. Cross-row `SUM(allocations) = payouts.amount_minor`
  dijaga service + test rekonsiliasi (tidak bisa CHECK).
- Alternatif yang **ditolak**: menyimpan `settlements.payout_id` tunggal — tidak mendukung payout
  parsial dan tidak mendukung satu payout menutup banyak order.

### 2.3 `payouts`

| Kolom                                                                        | Tipe                   | Constraint / alasan                                                                             |
| ---------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------- |
| `id`                                                                         | uuid PK                |                                                                                                 |
| `tenant_id`                                                                  | uuid NOT NULL          | FK `tenants(id)`; `UNIQUE (tenant_id, id)` untuk FK komposit `payout_allocations`               |
| `bank_account_id`                                                            | uuid NOT NULL          | FK `bank_accounts(id)` RESTRICT — **referensi**, bukan tujuan mutable (lihat snapshot di bawah) |
| `bank_code`, `account_number_masked`, `account_holder_name`                  | varchar NOT NULL       | **snapshot tujuan** saat request; perubahan rekening tidak mengubah payout lama [REQ §3.8.5]    |
| `amount_minor`                                                               | numeric NOT NULL       | `> 0`, integer, `< 1e38`                                                                        |
| `currency`                                                                   | varchar(3) NOT NULL    | `= 'IDR'`                                                                                       |
| `status`                                                                     | varchar(16) NOT NULL   | `requested / processing / succeeded / failed / cancelled`                                       |
| `provider`                                                                   | varchar(32) NOT NULL   | default `'sandbox'`                                                                             |
| `provider_reference`                                                         | varchar(120) NULL      | UNIQUE parsial `(provider, provider_reference)` WHERE NOT NULL                                  |
| `hold_ledger_transaction_id`                                                 | uuid NOT NULL          | FK `ledger_transactions`; terisi saat request (hold)                                            |
| `settle_ledger_transaction_id`                                               | uuid NULL              | FK; hanya saat `succeeded`                                                                      |
| `release_ledger_transaction_id`                                              | uuid NULL              | FK; hanya saat `failed`/`cancelled`                                                             |
| `requested_by_user_id`                                                       | uuid NOT NULL          | FK `users`; pemilik terverifikasi                                                               |
| `requested_at`, `processing_at`, `succeeded_at`, `failed_at`, `cancelled_at` | timestamptz NULL       | bidirectional CHECK per status                                                                  |
| `failure_code`, `last_error`                                                 | varchar(64)/(500) NULL | kode stabil + pesan aman; tanpa PII rekening                                                    |
| `version`                                                                    | integer NOT NULL       | `> 0`; optimistic concurrency (pola `schedule_proposals.version`)                               |
| `created_at`, `updated_at`                                                   | timestamptz NOT NULL   |                                                                                                 |

Constraint:

- **Satu payout aktif per tenant**: unique index parsial
  `payouts_one_active_per_tenant_uq ON payouts(tenant_id) WHERE status IN ('requested','processing')`.
- CHECK `payouts_status_check` (enum di atas), `payouts_amount_check` (`> 0`, integer),
  `payouts_currency_check` (`= 'IDR'`).
- CHECK `payouts_ledger_legs_check`: `hold_ledger_transaction_id IS NOT NULL` selalu;
  `succeeded` → `settle_ledger_transaction_id NOT NULL AND release_ledger_transaction_id IS NULL`;
  `failed`/`cancelled` → sebaliknya; `requested`/`processing` → keduanya NULL.
  **Ini invariant "tepat sekali" yang ditegakkan DB**: satu payout hanya boleh punya satu leg
  terminal.
- CHECK `payouts_timestamps_check` bidirectional (pola `refunds_succeeded_check`/`refunds_failed_check`).
- Indeks: `(tenant_id, created_at DESC)` (REQUIREMENTS §7.5), `(status, created_at)` untuk
  processor, `(requested_by_user_id)`.
- **Tidak ada** kolom `fee_minor`/`net_minor` di pilot (tidak ada kebijakan fee). Bila kelak
  diperlukan: migrasi baru + keputusan produk, bukan kolom spekulatif sekarang.

### 2.4 `bank_accounts`, `payout_attempts`, `payout_provider_events`, `payout_request_outbox`, `payout_events`

**`bank_accounts`** (REQUIREMENTS §7.2 + AGENTS.md data sensitif):

| Kolom                                                       | Constraint / alasan                                                                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                        | uuid PK                                                                                                                                           |
| `tenant_id`                                                 | FK `tenants`; `UNIQUE (tenant_id, id)` untuk FK komposit payout                                                                                   |
| `owner_user_id`                                             | FK `users`; pemilik yang mendaftarkan/memverifikasi                                                                                               |
| `bank_code`                                                 | varchar(20); kode bank terdaftar, bukan teks bebas                                                                                                |
| `account_holder_name`                                       | varchar(200)                                                                                                                                      |
| `account_number_ciphertext`                                 | text NOT NULL; **AES-256-GCM** dengan kunci dari env yang ada (pola `AUTH_ENCRYPTION_KEY`, D12.10); tidak pernah dicetak/di-log                   |
| `account_number_hash`                                       | varchar(64) NOT NULL; **HMAC-SHA256 berkunci** (nomor rekening entropi rendah → bukan hash polos) untuk dedupe/lookup; CHECK `~ '^[a-f0-9]{64}$'` |
| `account_number_masked`                                     | varchar(32) NOT NULL; mis. `****1234`; satu-satunya bentuk yang boleh keluar di API                                                               |
| `verification_status`                                       | `pending / verified / rejected` (§9 Q4 menentukan mekanismenya)                                                                                   |
| `verified_at`, `verified_by_user_id`, `verification_method` | NULL sampai terverifikasi; CHECK bidirectional                                                                                                    |
| `status`                                                    | `active / disabled`; rekening lama di-`disabled` saat diganti, **tidak dihapus**                                                                  |
| `is_default`                                                | boolean; unique parsial `(tenant_id) WHERE is_default AND status='active'`                                                                        |
| `version`, `created_by_user_id`, `created_at`, `updated_at` | pola standar                                                                                                                                      |

- **Perubahan rekening = baris baru** (nomor/bank/pemilik berubah → insert baru, `verification_status`
  kembali `pending`, baris lama `disabled`). Alasan: memenuhi "perubahan memerlukan verifikasi ulang
  dan audit" tanpa UPDATE in-place yang merusak histori, dan payout lama tetap menunjuk snapshot.
- `UNIQUE (tenant_id, bank_code, account_number_hash)` WHERE `status='active'` → rekening sama tidak
  terdaftar dua kali.
- Tidak ada endpoint yang mengembalikan ciphertext, hash, atau nomor lengkap. Dekripsi hanya di
  adapter payout saat memanggil provider, di luar transaksi DB (AGENTS.md).

**`payout_attempts`** — jejak tiap percobaan provider:
`id`, `payout_id` FK, `attempt_no` int `> 0`, `provider`, `status` (`pending|succeeded|failed|unknown`),
`provider_reference`, `error_code`, `error_message` (aman, tanpa rekening), `started_at`,
`finished_at`; **UNIQUE (payout_id, attempt_no)**; CHECK `finished_at` sesuai status terminal.
`unknown` dipakai bila hasil provider ambigu (timeout) → payout **tidak** boleh langsung dianggap
gagal; lihat §4.2.

**`payout_provider_events`** — dedupe callback/observer provider (pola `refund_provider_events`):
`payout_id`, `provider`, `event_id`, `event_type` (`payout.succeeded|payout.failed|payout.pending`),
`amount_minor`, `currency`, `provider_reference`, `occurred_at`, `received_at`, `processed_at`;
**UNIQUE (provider, event_id)** — replay tidak dapat memindahkan dana dua kali.

**`payout_request_outbox`** — outbox permintaan ke provider (pola `refund_request_outbox`):
`payout_id` UNIQUE, `status` (`pending|processing|done|dead`), `attempts`, `next_attempt_at`,
`lease_until`, `last_error`, `processed_at`, timestamps. Worker memanggil adapter **di luar**
transaksi/lock (AGENTS.md), lalu menulis hasil ke `payout_attempts` + transisi status.

**`payout_events`** — timeline append-only untuk UI detail payout (REQUIREMENTS §3.8.6):
`id`, `payout_id`, `version` (`> 0`), `from_status`, `to_status`, `actor_user_id` XOR `actor_service`
(CHECK, pola `order_events_actor_check`), `reason`, `metadata` jsonb (tanpa PII), `occurred_at`;
**UNIQUE (payout_id, version)**; `(payout_id, occurred_at, id)` indeks. Tidak ada UPDATE/DELETE normal.

### 2.5 Invariant yang harus dijaga DB (bukan hanya kode)

**Ditegakkan constraint DB:**

1. Satu settlement per order (`settlements_one_per_order_uq`).
2. Settlement/payout/allocation tidak dapat menunjuk order, payment, settlement, atau payout milik
   tenant lain (FK komposit berpola D12.3).
3. Settlement `paid_out_minor <= amount_minor`, dan `status='paid_out' ⇔ paid_out_minor = amount_minor`
   (CHECK).
4. `voided`/`reversed` hanya dengan `paid_out_minor = 0` → settlement yang sudah dibayar tidak bisa
   "dibatalkan diam-diam".
5. **Satu payout aktif per tenant** (unique parsial).
6. **Satu leg ledger terminal per payout** (`payouts_ledger_legs_check`) → "hold dipindah/dilepas
   tepat sekali" punya penjaga DB, bukan hanya percabangan kode.
7. Status payout ↔ timestamp konsisten dan bidireksional; status settlement ↔ timestamp idem.
8. Replay provider event tidak menggandakan efek (`UNIQUE (provider, event_id)`).
9. Uang selalu integer minor `> 0`; currency `IDR` pada pilot.
10. Ledger: `ledger_transactions` idempoten per `(idempotency_scope, idempotency_key)`, referensi
    `(namespace, id)` unik global, entri seimbang per transaksi (trigger deferred `docs/LEDGER.md`).

**Tidak dapat ditegakkan CHECK/UNIQUE (butuh service + row lock + test PostgreSQL):**

11. **Payable/hold tidak boleh negatif.** `wallet_accounts_balance_nonnegative_check` hanya berlaku
    untuk `account_type='wallet'`; akun system boleh negatif (`wallet.ts:60-63`). Karena itu
    `tenant.payable.*`/`tenant.payout.hold.*` (system) **tidak** otomatis menolak saldo negatif →
    service wajib `SELECT ... FOR UPDATE` + banding `balance >= amount` sebelum hold, dengan test
    konkurensi "N payout paralel, dana cukup K → tepat K sukses". [USULAN] root dapat menambahkan
    trigger DB (migrasi baru) yang menolak saldo negatif untuk `system_key LIKE 'tenant.payable.%'`
    dan `'tenant.payout.hold.%'` — lebih kuat, tetapi migrasi milik root (§9 Q6).
12. `SUM(payout_allocations.amount_minor) = payouts.amount_minor` per payout, dan
    `SUM(allocations per settlement) = settlements.paid_out_minor`.
13. `settlements.amount_minor = order_payments.amount_minor` untuk order yang sama (cross-table).
14. Total released per tenant + escrow + refund harus rekonsiliasi dengan ledger (§4.4).
15. Release hanya bila order `completed` dan tidak ada kasus terbuka — kombinasi lintas tabel
    `orders` + `cases`, dijaga transaksi + `FOR UPDATE` pada baris order dan `FOR SHARE` pada
    baris kasus.

## 3. Alur status

### 3.1 Settlement [USULAN]

```text
pending --release--> available --payout sukses--> paid_out      (terminal)
pending/available --refund sukses--> voided                     (terminal)
available --clawback pasca-release--> reversed                  (DITOLAK 409 di pilot)

Catatan: di pilot baris lahir langsung 'available' (§2.1), jadi 'pending' adalah
titik masuk teoretis untuk varian pencatatan sejak pembayaran.
```

| Transisi                      | Pemicu                                                                | Efek samping (satu transaksi)                                                                                              |
| ----------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pending -> available`        | order `completed` (handover tercatat) **dan** tidak ada kasus terbuka | INSERT settlement (`available`) + ledger escrow→payable + audit (outbox notifikasi belum: tidak ada event type settlement) |
| `available -> paid_out`       | payout `succeeded` (alokasi FIFO)                                     | UPDATE `paid_out_minor` + status bila penuh + `payout_allocations` + audit                                                 |
| `pending/available -> voided` | refund `succeeded` untuk order itu (order sudah `cancelled`)          | status `voided` + audit; **tidak ada** perpindahan ledger baru (uang sudah keluar escrow)                                  |
| `available -> reversed`       | klaim clawback pasca-release                                          | **DITOLAK 409 di pilot** (§9 Q3)                                                                                           |

Transisi ilegal ditolak `409 SETTLEMENT_STATE_CONFLICT` (bukan 500, bukan diam-diam):
`paid_out -> *`, `voided -> *`, `reversed -> *`, `available -> available` (release ganda),
`pending -> paid_out`, `available -> voided` bila refund belum `succeeded`.

### 3.2 Payout [USULAN]

```text
requested --provider dipanggil--> processing --sukses--> succeeded (terminal)
requested --batal oleh pemilik--> cancelled (terminal, hold dilepas)
requested --provider langsung gagal--> failed (terminal, hold dilepas)
processing --gagal/ambiguous--> failed (terminal) | needs manual review bila unknown
```

| Transisi                           | Aktor/izin                                     | Efek hold (tepat sekali)                                                |
| ---------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| (baru) `-> requested`              | pemilik terverifikasi, `tenant.payout.request` | **hold**: payable → hold, idempotensi `payouts.hold:<payoutId>`         |
| `requested -> processing`          | worker processor (service actor)               | tidak ada perpindahan ledger                                            |
| `processing -> succeeded`          | worker setelah hasil provider sukses           | **settle**: hold → clearing, `payouts.settle:<payoutId>` + alokasi FIFO |
| `requested -> cancelled`           | pemilik, `tenant.payout.request`               | **release**: hold → payable, `payouts.release:<payoutId>`               |
| `requested/processing -> failed`   | worker (gagal pasti)                           | **release**: hold → payable, `payouts.release:<payoutId>`               |
| `processing -> processing` (retry) | worker                                         | tidak ada; hanya `payout_attempts` baru                                 |

Ditolak `409 PAYOUT_STATE_CONFLICT`: `succeeded -> *`, `failed -> *`, `cancelled -> *`,
`requested -> succeeded` (tanpa `processing`), `processing -> cancelled` (provider sudah
dipanggil — [TANYA] bila produk ingin pembatalan di tengah jalan, butuh aturan tersendiri),
`failed -> processing` (payout gagal tidak diulang; pemilik mengajukan payout baru).

**"Tepat sekali" ditegakkan berlapis** [USULAN]:

1. `UPDATE payouts SET status='succeeded', ... WHERE id=$1 AND status='processing'` →
   `rowCount = 1` wajib; `0` = sudah ditangani proses lain → no-op idempoten, bukan efek kedua.
2. CHECK `payouts_ledger_legs_check` menolak leg terminal kedua pada baris yang sama.
3. Ledger idempoten (`idempotency_scope+key`) dan referensi unik → posting ulang mengembalikan
   transaksi yang sama (`replayed=true`), bukan transfer kedua.
4. `payout_provider_events` UNIQUE `(provider, event_id)` → replay callback tidak memindahkan dana.

## 4. Akuntansi ledger [USULAN]

### 4.1 Akun system yang dipakai

| System key                      | Status                                          | Peran                                                                                              |
| ------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `orders.payment.escrow`         | **sudah ada** (D16.1, `orders.constants.ts:54`) | dana pembayaran buyer ditahan; kredit saat checkout, debit saat release payable atau refund sukses |
| `tenant.payable.<tenantId>`     | **baru**                                        | dana milik tenant yang sudah dirilis dan **tersedia** untuk payout                                 |
| `tenant.payout.hold.<tenantId>` | **baru**                                        | dana yang di-hold karena payout aktif (belum masuk rekening)                                       |
| `payout.clearing`               | **baru**                                        | counter-account provider payout (boleh negatif, pola `SANDBOX_TOPUP_CLEARING_ACCOUNT` di top-up)   |

`systemKey` maksimum 120 karakter (`wallet.service.ts:120`) — pola `tenant.payable.<uuid>`
(50 karakter) aman. Alternatif satu akun global `tenant.payable` + pelacakan per tenant di tabel
ditampilkan di §9 Q1; rekomendasi: **per tenant**, karena (a) saldo tersedia = proyeksi akun
langsung tanpa agregasi rawan drift, (b) payout hanya bisa mendebit akun tenant-nya sendiri,
(c) rekonsiliasi per tenant trivial. Biaya: jumlah akun = 2 × jumlah tenant (pilot kecil).

### 4.2 Entri debit/kredit per transisi

`WalletService.postTransfer` hanya mendukung **satu pasang** debit/kredit per transaksi
(`wallet.service.ts:349-358`), jadi setiap perpindahan adalah satu transaksi seimbang sendiri.

| Peristiwa                     | Debit                           | Kredit                          | `idempotencyScope`       | `idempotencyKey` | `reference`                                  |
| ----------------------------- | ------------------------------- | ------------------------------- | ------------------------ | ---------------- | -------------------------------------------- |
| Release payable               | `orders.payment.escrow`         | `tenant.payable.<tenantId>`     | `settlements.release`    | `orderId`        | `{namespace:'settlement', id: settlementId}` |
| Payout request (hold)         | `tenant.payable.<tenantId>`     | `tenant.payout.hold.<tenantId>` | `payouts.hold`           | `payoutId`       | `{namespace:'payout_hold', id: payoutId}`    |
| Payout sukses (settle)        | `tenant.payout.hold.<tenantId>` | `payout.clearing`               | `payouts.settle`         | `payoutId`       | `{namespace:'payout_settle', id: payoutId}`  |
| Payout gagal/batal (release)  | `tenant.payout.hold.<tenantId>` | `tenant.payable.<tenantId>`     | `payouts.release`        | `payoutId`       | `{namespace:'payout_release', id: payoutId}` |
| Refund sukses (**sudah ada**) | `orders.payment.escrow`         | wallet buyer                    | `refunds.sandbox.credit` | `refundId`       | `{namespace:'refund', id: refundId}`         |

**Perangkap yang harus dihindari (sudah diperhitungkan):** `ledger_transactions_reference_uq`
membuat `(reference_namespace, reference_id)` unik **global** (`wallet.ts:107-109`). Karena itu tiga
leg payout memakai namespace berbeda (`payout_hold`/`payout_settle`/`payout_release`); memakai satu
namespace `payout` akan menggagalkan leg kedua dengan 409.

Semua pemanggilan memakai `client` transaksi pemanggil, `actor: {type:'service', id:'settlements'|'payouts-processor'}`
untuk leg otomatis dan `{type:'user', id: actorUserId}` untuk hold/release yang dipicu pemilik.
`metadata` hanya berisi id dan tenantId — tanpa rekening, nama pemilik, atau nomor apa pun.

### 4.3 Saldo tersedia = proyeksi ledger (bukan angka bebas)

- `available_minor(tenant) = wallet_accounts.balance_minor` untuk `system_key='tenant.payable.<tenantId>'`
  (dipelihara trigger `ledger_entries_apply_projection`, `docs/LEDGER.md`).
- `held_minor(tenant) = balance_minor` akun `tenant.payout.hold.<tenantId>`.
- Ringkasan keuangan tenant (REQUIREMENTS §3.8.1) diturunkan dari ledger + tabel, bukan kolom saldo
  baru: `paid_in` = Σ `order_payments`, `refunded` = Σ `refunds succeeded`, `unfinished` = Σ
  `orders` non-terminal, `available` = akun payable, `held` = akun hold, `paid_out` = Σ
  `payouts succeeded`.
- Payout request **wajib**: `SELECT balance_minor FROM wallet_accounts WHERE system_key=... FOR UPDATE`
  → banding BigInt (bukan `number`) → baru `postTransfer`. Lock diambil sebelum lock akun oleh
  `postTransfer` (yang juga `FOR UPDATE` di kedua akun, urut UUID) sehingga tidak ada lock-upgrade.

### 4.4 Identitas rekonsiliasi yang wajib diuji

Per tenant, per currency (IDR):

```text
(1) payable_balance + hold_balance + Σ payouts.succeeded.amount = Σ settlements(released).amount
(2) Σ payout_allocations.amount per payout            = payouts.amount_minor
(3) Σ payout_allocations.amount per settlement        = settlements.paid_out_minor
(4) escrow_balance = Σ order_payments.amount − Σ refunds.succeeded.amount − Σ settlements(released).amount
(5) Σ settlements(released).amount = Σ order_payments.amount untuk order berstatus completed tanpa refund
```

(1) berlaku karena settle memindahkan hold → clearing (payable+hold turun sebesar X, paid_out naik X)
dan release mengembalikan hold → payable. (4) menangkap order `cancelled`/`declined` yang dananya
masih di escrow menunggu keputusan refund — memang harus tetap terlihat, bukan dianggap selisih.

## 5. Otorisasi [REQ + USULAN]

### 5.1 Permission (semua sudah ada di `src/modules/access/access.service.ts`, D10 — jangan tambah nama baru)

| Aksi                                          | Permission                   | Catatan                           |
| --------------------------------------------- | ---------------------------- | --------------------------------- |
| Lihat ringkasan/transaksi keuangan tenant     | `tenant.finance.read`        | pemilik terverifikasi; staf tidak |
| Lihat & kelola rekening bank                  | `tenant.bank_account.manage` | hanya pemilik terverifikasi       |
| Ajukan/batalkan payout                        | `tenant.payout.request`      | hanya pemilik terverifikasi       |
| Pantau payout kampus (read-only, tersamarkan) | `campus.payouts.read`        | tanpa kemampuan memindahkan dana  |
| Pantau transaksi/settlement kampus            | `campus.transactions.read`   | pola yang sudah dipakai refunds   |

Sudah ditegakkan mesin akses yang ada (tidak perlu kode baru, cukup test):

- `TENANT_FINANCE_PERMISSIONS` (`finance.read`, `bank_account.manage`, `payout.request`) →
  role selain `owner` **selalu** ditolak (`access.service.ts:159-165`), dan owner wajib
  `owner_verified_at NOT NULL` (`access.service.ts:155-158`). Jadi **staf dapur/pickup tidak
  mungkin** mengakses rekening/payout, sekalipun permissions-nya disetel manual.
- `STAFF_ROLE_PERMISSIONS` kitchen/pickup tidak memuat satu pun permission finance
  (`access.service.ts:47-66`) → defense in depth.

### 5.2 Aturan tambahan yang wajib ditegakkan service [USULAN]

- `tenantId` dan `payoutId` selalu berasal dari resource + sesi; tidak pernah dari body.
  Resource tenant lain → **404** (bukan 403, pola orders/refunds).
- Rekening: `bank_account_id` pada payout harus `tenant_id` yang sama **dan** `verification_status='verified'`
  **dan** `status='active'`; selain itu `409 PAYOUT_BANK_ACCOUNT_UNVERIFIED`.
- Kampus **tidak** punya jalur approve/reject payout. Tidak ada endpoint mutasi payout untuk kampus.
- Response rekening selalu tersamarkan; ciphertext/hash/nomor lengkap tidak pernah keluar dari
  service (termasuk Swagger example dan log Pino).

### 5.3 Audit wajib (`AuditService.append` dalam transaksi yang sama) [USULAN]

| Action                             | Aktor          | Scope  | Wajib memuat                               |
| ---------------------------------- | -------------- | ------ | ------------------------------------------ |
| `tenant.bank_account.created`      | user (pemilik) | tenant | masked, bank_code, reason                  |
| `tenant.bank_account.replaced`     | user (pemilik) | tenant | id lama + id baru, reason                  |
| `tenant.bank_account.verified`     | user/service   | tenant | metode verifikasi, alasan                  |
| `tenant.bank_account.disabled`     | user (pemilik) | tenant | reason                                     |
| `tenant.payable.released`          | service        | tenant | orderId, settlementId, amountMinor         |
| `tenant.payout.requested`          | user (pemilik) | tenant | payoutId, amountMinor, masked tujuan       |
| `tenant.payout.cancelled`          | user (pemilik) | tenant | payoutId, reason                           |
| `tenant.payout.succeeded`/`failed` | service        | tenant | payoutId, provider reference, failure_code |

Tanpa angka sensitif di `metadata`: hanya id, nominal, masked, dan kode. Perubahan rekening **dan**
setiap payout wajib punya baris audit — [REQ] "aksi keuangan … menghasilkan audit dengan aktor,
target, alasan dan waktu".

## 6. Kontrak lintas slice [USULAN]

Semua method menerima `PoolClient` milik transaksi pemanggil (pola D13/D16.6) dan tidak pernah
commit/rollback sendiri. Pemanggil memegang otorisasi.

```ts
// --- OrdersService (slice orders) ---
getOrderSettlementContext(
  client: PoolClient,
  orderId: string,
): Promise<{
  orderId: string;
  tenantId: string;
  buyerId: string;
  status: string;            // 'completed' | ... (dari baris, bukan parameter)
  completedAt: string | null; // string mikrodetik DB (D7)
  orderPaymentId: string;
  amountMinor: string;
  currency: string;
}>;
// SELECT ... FOR UPDATE pada orders; unknown -> 404; tidak mengotorisasi.
// Release WAJIB menolak bila status <> 'completed' -> 409 SETTLEMENT_NOT_HANDED_OVER.

// --- CasesService (slice cases) ---
hasOpenCasesForOrder(
  client: PoolClient,
  tenantId: string,
  orderId: string,
): Promise<boolean>;
// open = status IN ('reported','under_review','awaiting_information')
// (enum cases.ts:81). SELECT ... FOR SHARE pada baris kasus yang cocok, agar
// keputusan kasus paralel terserialisasi terhadap release.

// --- RefundsService (slice refunds) ---
getRefundStateForOrder(
  client: PoolClient,
  orderId: string,
): Promise<{ refundId: string; status: string } | null>;
// dipakai release untuk menolak order yang punya refund live/succeeded.

// --- SettlementsService (slice baru) ---
releaseForOrder(
  client: PoolClient,
  orderId: string,
): Promise<
  | { released: true; settlementId: string; amountMinor: string; ledgerTransactionId: string }
  | { released: false; reason: 'not_completed' | 'open_case' | 'already_released' | 'refund_pending' }
>;
// idempoten: replay mengembalikan already_released tanpa posting kedua.
// Urutan: FOR UPDATE orders -> cek status -> FOR SHARE cases -> cek refund ->
//         lock akun escrow+payable -> postTransfer -> INSERT settlements -> audit.

voidSettlementForRefund(
  client: PoolClient,
  orderId: string,
  refundId: string,
): Promise<void>;
// DIPANGGIL slice refunds setelah refund sukses (idempoten; settlement -> 'voided',
// paid_out_minor wajib 0 sehingga settlement yang sudah dibayar tidak bisa di-void).

getAvailableBalance(
  client: PoolClient | undefined,
  tenantId: string,
  currency: 'IDR',
): Promise<{ availableMinor: string; heldMinor: string }>;
// proyeksi ledger, bukan kolom saldo.

// --- PayoutsService (slice baru) ---
requestPayout(
  actorUserId: string,
  tenantId: string,
  input: { bankAccountId: string; amountMinor: string; idempotencyKey: string },
): Promise<{ payoutId: string; status: 'requested'; amountMinor: string; replayed: boolean }>;
// satu transaksi: requireTenant('tenant.payout.request') -> lock payable -> cek saldo ->
// postTransfer hold -> INSERT payouts + payout_request_outbox + payout_events + audit.

cancelPayout(actorUserId, tenantId, payoutId, reason): Promise<void>;
// hanya status 'requested' -> 'cancelled' + release hold + audit.

// --- WalletService (fondasi; penambahan kecil, mohon persetujuan root) ---
lockSystemAccount(
  systemKey: string,
  currency: string,
  client: PoolClient,
): Promise<{ accountId: string; balanceMinor: string }>;
// SELECT ... FOR UPDATE; dibutuhkan agar cek saldo tersedia atomik dan
// urutan lock konsisten dengan postTransfer. Alternatif: modul settlements
// membaca wallet_accounts sendiri (boleh, read-only) tetapi lock lintas modul
// lebih jelas bila dipusatkan di pemilik tabel.
```

Catatan integrasi:

- **Tidak ada** modul lain yang menulis `orders`, `cases`, `refunds`, `wallet_*` (D4).
- Outbox memakai `payout.status_changed` yang **sudah** ada di `DOMAIN_EVENT_TYPES`
  (`outbox.service.ts:18`) — tidak perlu event type baru.
- Env baru `PAYOUTS_PROVIDER_MODE` (`disabled` default, production hanya `disabled`, `sandbox` untuk
  uji) mengikuti pola `PAYMENTS_PROVIDER_MODE`/`REFUNDS_PROVIDER_MODE`; file env/config milik root
  (D2) → diajukan, tidak diedit agent.
- Queue wiring milik root (D11): usul `PAYOUT_REQUESTS_QUEUE = 'payout-requests'` +
  `PayoutRequestDispatcher`/`PayoutRequestProcessor` di `src/jobs/jobs.module.ts` dan
  `src/worker.module.ts`.

## 7. Endpoint HTTP usulan [USULAN]

Prefix `/api/v1`, timestamp mikrodetik DB (D7), uang string desimal, `Idempotency-Key` wajib untuk
mutasi finansial (REQUIREMENTS §8).

| Method | Path                                          | Permission                   | Catatan                                                        |
| ------ | --------------------------------------------- | ---------------------------- | -------------------------------------------------------------- |
| GET    | `/tenants/:tenantId/finance/summary`          | `tenant.finance.read`        | paid-in, refunded, unfinished, available, held, paid_out       |
| GET    | `/tenants/:tenantId/finance/transactions`     | `tenant.finance.read`        | cursor; turunan ledger akun payable/hold + settlements         |
| GET    | `/tenants/:tenantId/bank-accounts`            | `tenant.bank_account.manage` | selalu tersamarkan                                             |
| POST   | `/tenants/:tenantId/bank-accounts`            | `tenant.bank_account.manage` | baris baru, `verification_status='pending'`                    |
| POST   | `/tenants/:tenantId/bank-accounts/:id/verify` | `tenant.bank_account.manage` | **mekanisme = §9 Q4**; sampai diputuskan, endpoint belum aktif |
| POST   | `/tenants/:tenantId/payouts`                  | `tenant.payout.request`      | `Idempotency-Key` wajib; hold atomik                           |
| GET    | `/tenants/:tenantId/payouts` (+ `/:payoutId`) | `tenant.finance.read`        | timeline dari `payout_events`                                  |
| POST   | `/tenants/:tenantId/payouts/:payoutId/cancel` | `tenant.payout.request`      | hanya `requested`                                              |
| GET    | `/campuses/:campusId/payouts`                 | `campus.payouts.read`        | read-only, tujuan tersamarkan                                  |
| GET    | `/campuses/:campusId/settlements`             | `campus.transactions.read`   | pantauan; tanpa mutasi                                         |

Kode error stabil yang diusulkan: `SETTLEMENT_STATE_CONFLICT`, `SETTLEMENT_NOT_HANDED_OVER`,
`SETTLEMENT_OPEN_CASE_BLOCKED`, `SETTLEMENT_ALREADY_RELEASED`, `PAYOUT_AMOUNT_EXCEEDS_AVAILABLE`,
`PAYOUT_ACTIVE_EXISTS`, `PAYOUT_BANK_ACCOUNT_UNVERIFIED`, `PAYOUT_STATE_CONFLICT`,
`PAYOUT_PROVIDER_DISABLED`, `PAYOUT_IDEMPOTENCY_REUSED`, `BANK_ACCOUNT_NOT_VERIFIED`.

## 8. Risiko

| #   | Risiko                                                                 | Mitigasi yang diusulkan                                                                    |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| R1  | Payable/hold negatif tidak dicegah DB (akun system boleh negatif)      | lock + cek BigInt + test konkurensi; opsi trigger DB (Q6)                                  |
| R2  | Release ganda akibat retry job/worker                                  | UNIQUE per order + ledger idempoten + UPDATE kondisional status                            |
| R3  | Kasus dibuka bersamaan dengan release (write skew)                     | `FOR SHARE` pada kasus + `FOR UPDATE` pada order, urutan lock tetap                        |
| R4  | Rekening berubah setelah payout diajukan                               | snapshot tujuan di baris payout + rekening lama `disabled`, bukan di-UPDATE                |
| R5  | Nomor rekening bocor lewat log/error/Swagger                           | ciphertext + masked saja di API; larangan log; test yang memindai response                 |
| R6  | Provider timeout → status ambigu, dana "hilang" antara hold dan settle | `payout_attempts.status='unknown'` + antrean manual; **jangan** auto-release hold          |
| R7  | Ledger leg kedua gagal karena namespace referensi bentrok              | tiga namespace terpisah (§4.2) + test                                                      |
| R8  | Settlement menunjuk order/payment tenant lain                          | FK komposit berpola D12.3 + test lintas tenant                                             |
| R9  | Escrow negatif karena release + refund untuk order yang sama           | release hanya `completed`; refund hanya `cancelled`; cek refund di dalam transaksi release |
| R10 | Queue wiring & env baru tertinggal                                     | daftar kebutuhan eksplisit ke root (D2/D11), bukan edit sendiri                            |

## 9. Pertanyaan keputusan untuk root

1. **Q1 — Akun payable per tenant vs global.** Rekomendasi per tenant (§4.1). Konsekuensi global:
   saldo tersedia harus diagregasi dari tabel dan isolasi tenant bergantung kode, bukan ledger.
2. **Q2 — Pemicu release.** (a) di transaksi handover pickup (butuh perubahan slice pickup yang
   sudah diterima), (b) dipanggil ulang saat kasus mencapai status terminal, (c) job penyapu untuk
   order `completed` yang masih tertahan. Rekomendasi: (a)+(b) wajib, (c) opsional sebagai jaring
   pengaman — bukan "jadwal batch payout", tetapi tetap keputusan root karena menyentuh slice lain.
3. **Q3 — Refund/chargeback setelah dana dirilis.** PILOT-POLICY hanya mengizinkan refund penuh
   sebelum/setelah keputusan pembatalan, dan keputusan pembatalan menolak order `completed`. Jadi
   pilot: refund pasca-release **ditolak** (409). Bila produk ingin clawback, perlu aturan saldo
   negatif/penagihan tenant — belum ada dasarnya.
4. **Q4 — Verifikasi rekening.** Mekanisme belum ditetapkan: (i) provider bank name-match,
   (ii) verifikasi manual oleh pengelola kampus (bukan approval per payout, tetapi verifikasi
   pemilik rekening), (iii) keduanya. Tanpa keputusan ini endpoint `verify` tidak boleh aktif dan
   payout hanya bisa ke rekening berstatus `verified` yang dibuat lewat jalur terkontrol.
5. **Q5 — Batas nominal & partial payout.** Rekomendasi: `amount > 0` dan `≤ dana tersedia`
   (partial diizinkan, PILOT-POLICY "maksimum dana tersedia"). Minimum/maksimum operasional dan
   apakah saldo harus ditarik penuh = belum ada dasar → perlu keputusan bila ingin ada batas.
6. **Q6 — Penjaga DB untuk saldo payable/hold.** Tambah trigger penolak negatif (migrasi baru,
   milik root) atau cukup service + test? Rekomendasi trigger, tetapi tidak boleh dibuat agent.
7. **Q7 — Retensi & rekonsiliasi.** Retensi idempotency/outbox/payout_events, penyimpanan bukti
   transfer, dan siapa menjalankan rekonsiliasi (§4.4) belum ditetapkan (REQUIREMENTS §7.6).
8. **Q8 — Fee provider payout.** PILOT-POLICY menyatakan pilot tidak memungut fee, tetapi biaya
   provider nyata (bila kelak ada) dan siapa menanggungnya belum diputuskan → tidak ada kolom fee
   di desain ini.
9. **Q9 — Pembatalan payout saat `processing`.** Rekomendasi ditolak (provider sudah dipanggil).
   Bila produk ingin, perlu alur rekonsiliasi tersendiri.
10. **Q10 — Penambahan `WalletService.lockSystemAccount`** dan env `PAYOUTS_PROVIDER_MODE`
    (file milik root/fondasi) — mohon persetujuan sebelum implementasi.

## 10. Rencana pecahan kerja (siap ditugaskan)

Urutan wajib: **T1 → (T2, T3 paralel) → T4**. Semua task: tanpa commit/push, tanpa mengubah migrasi
lama, tanpa nested delegation (D6), test memakai `npx tsc -p tsconfig.test.json` + `node --test`
terhadap PostgreSQL slice sendiri (D6).

### T1 — Schema + migrasi 0009 (fondasi, harus pertama)

- **Scope file:** `src/database/schema/settlements.ts` (baru: `settlements`, `payout_allocations`),
  `src/database/schema/payouts.ts` (baru: `payouts`, `payout_attempts`, `payout_provider_events`,
  `payout_request_outbox`, `payout_events`, `bank_accounts`), `src/database/schema/index.ts` (export),
  `drizzle/0009_*.sql` + metadata (root yang generate/apply), `test/settlement-schema.spec.ts`.
- **Kriteria penerimaan:** migrasi apply bersih di PostgreSQL 17 baru setelah 0000..0008; seluruh
  baseline test integrasi yang ada tetap lulus; test integritas membuktikan setiap constraint §2.5
  butir 1–10 menolak data yang salah (satu settlement/order, FK komposit lintas tenant, satu payout
  aktif/tenant, dua leg terminal, status↔timestamp, replay provider event); tidak ada perubahan pada
  migrasi lama.
- **Prasyarat:** root menyetujui Q1 (bentuk system key) dan Q6.

### T2 — Modul settlements + release + ringkasan keuangan

- **Scope file:** `src/modules/settlements/` (service, module, controller, dto),
  `test/settlements.spec.ts`, `docs/modules/settlements.md`; penambahan method baca di
  `src/modules/orders/orders.service.ts` (`getOrderSettlementContext`) dan
  `src/modules/cases/cases.service.ts` (`hasOpenCasesForOrder`) — **hanya penambahan**, tidak
  mengubah perilaku yang sudah diterima.
- **Kriteria penerimaan:** release idempoten (replay → `already_released`, tanpa posting kedua);
  release ditolak untuk order belum `completed`, ada kasus terbuka, atau ada refund; saldo escrow
  dan payable berubah tepat sebesar `amount_minor` dengan ledger seimbang; audit
  `tenant.payable.released` tertulis; dua release paralel → tepat satu menang; GET summary/transactions
  hanya untuk pemilik terverifikasi (403 untuk staf, 404 untuk tenant lain); identitas rekonsiliasi
  (1),(4),(5) §4.4 lulus test.

### T3 — Modul rekening bank (enkripsi, masking, verifikasi)

- **Scope file:** `src/modules/payouts/bank-accounts.*` (service/controller/dto),
  `src/modules/payouts/crypto.ts` (AES-256-GCM + HMAC helper, kunci dari env yang ada),
  `test/bank-accounts.spec.ts`, `docs/modules/payouts.md` (bagian rekening).
- **Kriteria penerimaan:** nomor lengkap tidak pernah tersimpan plaintext dan tidak pernah muncul
  di response/log; dua rekening sama (bank+hash) ditolak 409; satu default aktif per tenant;
  penggantian rekening membuat baris baru, baris lama `disabled`, `verification_status='pending'`,
  dan baris audit; staf dapur/pickup ditolak 403 pada semua route; verifikasi **tidak diaktifkan**
  sampai Q4 diputuskan (endpoint mengembalikan 503 `BANK_ACCOUNT_VERIFICATION_DISABLED`).

### T4 — Modul payouts + adapter sandbox + processor

- **Scope file:** `src/modules/payouts/payouts.*` (service/controller/dto),
  `payout.adapter.ts` + `payout-request.processor.ts`, `test/payouts.spec.ts`,
  `docs/modules/payouts.md`; `src/config/environment.ts` + `.env.example` **hanya bila root
  menyetujui** (`PAYOUTS_PROVIDER_MODE`); wiring queue oleh root (D11).
- **Kriteria penerimaan:** request memotong dana tersedia secara atomik (hold) dan menolak
  `> available`; N request paralel dengan dana cukup K → tepat K sukses, payable/hold tidak pernah
  negatif; satu payout aktif per tenant (409 `PAYOUT_ACTIVE_EXISTS`); sukses memindahkan hold
  tepat sekali (ledger seimbang, alokasi FIFO, `paid_out_minor` konsisten); gagal/batal melepas hold
  tepat sekali; replay provider event tidak menggandakan efek; mode `disabled` menolak 503
  `PAYOUT_PROVIDER_DISABLED`; rekening `pending`/tenant lain ditolak 409/404; seluruh identitas
  rekonsiliasi §4.4 lulus; tidak ada panggilan provider di dalam transaksi/lock.

## 11. Daftar periksa review (untuk root)

- [ ] Q1–Q10 §9 diputuskan atau secara eksplisit ditunda (dan slice mana yang menunggu).
- [ ] Setuju `settlements` dibuat saat release (tanpa baris `pending`), atau minta pencatatan sejak
      pembayaran (berarti slice orders harus memanggil `SettlementsService.recordPaidOrder`).
- [ ] Setuju tiga namespace referensi ledger (§4.2) dan nama system key baru untuk registri akun.
- [ ] Setuju penambahan `WalletService.lockSystemAccount` (fondasi) dan method baca di orders/cases.
- [ ] Setuju bahwa fee/pajak **tidak** dimodelkan sekarang.
- [ ] Menetapkan pemilik slice: `settlements` + `payouts` (termasuk `bank_accounts`) — D4 belum
      menetapkan pemilik tabel-tabel ini.
