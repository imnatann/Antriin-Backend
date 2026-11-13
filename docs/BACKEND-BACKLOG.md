# Backend Backlog — Antriin

Status kerja 12 November 2026. Root mengoordinasikan implementasi backend dengan tiga subagent GPT-6 Luna; tiket frontend/shared dan epic tidak diubah. Pengguna mengizinkan commit/push berkala, sandbox/stub, dan mendelegasikan kebijakan awal yang tercatat dalam [PILOT-POLICY.md](PILOT-POLICY.md).

## Baseline dan checkpoint

Baseline awal hanya health, tiga tabel dan worker probe; audit awal lulus empat tes health. Baseline tersebut disimpan pada commit `f8eb57e`. Commit `44afdfa` menambah kebijakan pilot, konfigurasi keamanan, error contract dan runner integrasi; kedua commit sudah di-push dan CI sukses.

Checkpoint domain berikutnya mencakup implementasi berikut, dengan provider eksternal tetap belum aktif:

- OTP/hash/enkripsi/expiry/attempt/cooldown, sesi opaque/refresh/revoke, verifikasi kampus terpisah dan rate limit IP Redis.
- Permission tenant/campus granular, staf tenant scoped, audit perubahan akses immutable.
- Wallet/ledger double-entry immutable, proyeksi saldo dari entries, idempotency/hash/ref, row locking dan read API buyer IDR.
- Transactional outbox domain, worker BullMQ retry/dedupe, notifikasi dalam aplikasi, audit umum dan query audit kampus.
- Sembilan belas tabel dan migrasi bertahap; tidak ada saldo/order produksi yang di-seed.

Pemeriksaan checkpoint: `npm run test:integration` telah menerapkan migrasi dari database PostgreSQL baru dan menjalankan Redis/BullMQ nyata dengan **44/44 tes lulus**. Typecheck, lint, format dan build juga lulus. Review independen terakhir meminta query audit memakai satu transaksi berizin serta penolakan bulk truncate audit akses; perbaikan dibuat melalui migrasi tambahan dan divalidasi lagi pada snapshot commit. Hasil final exact staged snapshot lulus kembali seluruh pemeriksaan dan 44/44 tes sesudah perbaikan audit; commit `9ab4a50` telah di-push dan [CI sukses](https://github.com/BagasDwikiPurnomo/Antriin-Backend/actions/runs/43134757693). Lanjutan ada di [HANDOFF.md](HANDOFF.md).

`.env` lokal tidak diubah dan tidak dipakai sebagai target migrasi. Container uji menggunakan nama unik, port loopback dan data sementara; runner membersihkan hanya container miliknya. Uji provider memakai port terkontrol; ini bukan bukti pengiriman WhatsApp/email, QRIS nyata, refund bank atau payout production.

## Status implementasi 12 November 2026 (sesi orkestrasi DSH)

Ringkasan keadaan nyata setelah wave 1, wave 2a dan pickup. Bukti terakhir: `npm run test:integration` menerapkan migrasi `0000..0008` pada PostgreSQL baru dan menjalankan **231/231 tes** dengan Redis/BullMQ nyata, tanpa skip; typecheck, lint, format dan build lulus.

| Slice                                 | Commit    | Bukti                                                                                                    |
| ------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| Schema 0006 (katalog/order/payment)   | `3c72799` | 39 tabel, 54 FK; 44/44 tes baseline                                                                      |
| Schema 0007 (integritas hasil review) | `52fbf75` | 9 FK, 4 UNIQUE, 2 PK, 15 kolom, 15 CHECK; 15/15 tes integritas + 40/40 regresi                           |
| Wave 1 + orders                       | `e677798` | katalog, availability, tenant/kampus, payments, checkout/proposal; 189/189                               |
| Schema 0008 (kasus/refund)            | `7203b30` | 4 tabel + dedupe provider refund; 43 tabel, 80 FK                                                        |
| Perbaikan review wave 1               | `56b4d1d` | deadlock katalog, kode kontrak error, audit slot, retry orders, write-skew, liveness dispatcher payments |
| Pickup                                | `0e35827` | kredensial hash + handover sekali; 11 tes PostgreSQL                                                     |
| Ketegasan kontrak retry orders        | `c71ab28` | 16/16 tes checkout                                                                                       |

Laporan review independen tersimpan di [reviews/](reviews/): `schema-wave1.md` (1 blocker/7 major), `schema-0007.md` (implementasi), `wave1-catalog-availability.md` (1 blocker/2 major/9 minor), `wave1-payments-tenant.md` (0 blocker/1 major/8 minor). Keputusan lintas slice yang mengikat ada di [reviews/wave1-decisions.md](reviews/wave1-decisions.md) D1–D17.

Belum selesai: refunds/cases (sedang dikerjakan), settlement/payout, review/risk/reporting, profil `/me`, dan dispatcher OTP eksternal. Semua provider eksternal tetap sandbox/stub; tidak ada uang nyata, deployment, atau migrasi produksi yang diklaim.

## Status implementasi 13 November 2026 (lanjutan sesi orkestrasi DSH)

Setelah review independen dan perbaikan, seluruh slice wave 1, wave 2a, pickup, refunds dan cases sudah terintegrasi. Bukti terakhir: `npm run test:integration` menerapkan migrasi `0000..0008` pada PostgreSQL baru dan menjalankan **281/281 tes** dengan Redis/BullMQ nyata, tanpa skip; typecheck, lint, format dan build lulus.

| Slice                                                      | Commit    | Bukti                          |
| ---------------------------------------------------------- | --------- | ------------------------------ |
| Refunds (keputusan kampus, kredit tepat sekali)            | `d49a806` | 14 tes PostgreSQL              |
| Perbaikan review pickup (rate limit, test HTTP/konkurensi) | `dee2893` | 16 PG + 7 HTTP + 7 interceptor |
| Cases (keputusan kampus, refund pending)                   | `5e0bf87` | 17 tes PostgreSQL              |

Laporan review independen di [reviews/](reviews/): `schema-wave1.md`, `schema-0007.md`, `wave1-catalog-availability.md`, `wave1-payments-tenant.md`, `wave1-pickup.md`, dan `wave1-refunds-cases.md`. Keputusan lintas slice mengikat ada di [reviews/wave1-decisions.md](reviews/wave1-decisions.md) D1–D17.

Catatan proses: sesi ini memakai harness DSH dengan model subagent `inferhub/deepseek-v4.1-flash` (bukan GPT-6 Luna seperti tertulis pada checkpoint sebelumnya); aturan ORCHESTRATION lain tetap dipatuhi.

Belum selesai: settlement/payout/rekening (desain sedang disusun), review/risk/reporting, profil `/me`, dispatcher OTP eksternal, dan job operasional (pembersih idempotency/outbox). Tidak ada provider nyata, deployment, atau migrasi produksi yang diklaim.

## Status implementasi 13 November 2026 (lanjutan 2)

Settlement/payout/rekening bank selesai diimplementasikan dan diintegrasikan, setelah desainnya diputuskan root (D18). Review refunds/cases juga ditutup.

| Slice                                                  | Commit    | Bukti                                          |
| ------------------------------------------------------ | --------- | ---------------------------------------------- |
| Schema 0009 (settlements/payouts/bank accounts)        | `9d1e17b` | 51 tabel, 101 FK; baseline 281/281 tetap lulus |
| Keputusan desain D18                                   | `3bb8e9a` | Q1–Q10 dijawab, env `PAYOUTS_PROVIDER_MODE`    |
| Refunds/cases review follow-up + settlements + payouts | `101feca` | 353/353 tes integrasi                          |

Keadaan per slice sekarang:

- **Settlements**: release memindahkan dana dari escrow order ke akun payable tenant tepat sekali, hanya untuk order `completed` tanpa kasus terbuka dan tanpa refund. Dipicu di transaksi handover pickup dan pada keputusan kasus terminal, tanpa pernah menggagalkan alur tersebut (savepoint + audit `release_deferred`/`release_failed`).
- **Payouts**: pemilik terverifikasi meminta payout; dana di-hold atomik dari akun payable, satu payout aktif per tenant, snapshot tujuan sehingga perubahan rekening tidak mengubah payout lama. Processor sandbox berjalan di luar lock, dedupe provider event, dan memindahkan hold ke akun clearing dengan alokasi FIFO ke settlements — atau melepasnya kembali — tepat sekali (`payouts_ledger_legs_check`).
- **Rekening bank**: ciphertext AES-256-GCM + HMAC untuk dedupe + masking; penggantian rekening membuat baris baru dan menonaktifkan yang lama; verifikasi masih 503 sampai mekanismenya diputuskan (Q4).
- **Refunds/cases**: 13 route kini punya test HTTP kontrak, timestamp mikrodetik, sisi debit escrow diassert lewat transaksi ledger refund, dan celah TOCTOU pembukaan kasus ditutup.

Yang masih terbuka (dicatat, bukan diklaim selesai): review/risk/reporting, profil `/me`, dispatcher OTP eksternal, job operasional (pembersih idempotency/outbox, penyapu release, retensi/rekonsiliasi), trigger DB penolak saldo negatif untuk akun system (Q6), dan jalur penyelesaian payout/refund berstatus `needs_assistance`. Tidak ada provider nyata, deployment, atau migrasi produksi yang diklaim.

## Status implementasi 13 November 2026 (lanjutan 3)

Review independen settlement/payout sudah ditutup seluruhnya (0 blocker, 2 major, 7 minor). Bukti akhir: **382/382 tes integrasi** pada migrasi `0000..0009`, typecheck/lint/format/build lulus, API (`/api/v1/health/ready`, `/docs`) dan worker boot bersih dengan modul payouts/settlements ter-resolve.

| Commit    | Isi                                                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `9d1e17b` | Migrasi 0009: settlements, payouts, bank accounts, allocations, attempts, provider events, outbox, payout events                                                                                                          |
| `3bb8e9a` | Keputusan desain D18 (Q1–Q10) + env `PAYOUTS_PROVIDER_MODE`                                                                                                                                                               |
| `101feca` | Implementasi settlements/payouts/rekening + follow-up review refunds/cases                                                                                                                                                |
| `dcc2be7` | Laporan review independen settlements/payouts                                                                                                                                                                             |
| `6bbf20d` | Penutupan temuan review: test constraint 0009, pemicu release handover benar-benar diuji, provider disabled = gagal permanen (hold dilepas), cek kepemilikan rekening, otorisasi sebelum kripto, pemantauan payout kampus |

Yang masih terbuka dan **tidak** diklaim selesai:

- `GET /api/v1/campuses/:campusId/settlements` (pemantauan settlement kampus) — ditunda, dicatat di docs.
- FK komposit `(tenant_id, bank_account_id)` untuk `payouts` — perlu migrasi baru (milik root).
- Trigger DB penolak saldo negatif akun system (Q6) — pengganti sementara: lock + BigInt + test konkurensi.
- Jalur penyelesaian `needs_assistance` untuk payout/refund dengan hasil provider ambigu.
- Slice review/risk/reporting, profil `/me`, dispatcher OTP eksternal, dan job operasional (pembersih idempotency/outbox, penyapu release, retensi/rekonsiliasi).

Tidak ada provider nyata, deployment, atau migrasi produksi yang diklaim.

## Status implementasi 13 November 2026 (lanjutan 4) — slice ulasan

Slice **reviews** (KAN-70) diimplementasikan: skema migrasi `0010`, 10 route, dan 18 tes baru (9 PostgreSQL + 9 kontrak HTTP). Detail perilaku ada di [modules/reviews.md](modules/reviews.md).

| Isi            | Rincian                                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrasi `0010` | 4 tabel (`reviews`, `review_replies`, `review_reports`, `review_moderation_actions`), FK komposit tenant-ke-order dan tenant-ke-review, unique satu ulasan per order, CHECK rating/status/jejak penyembunyian.             |
| Aturan inti    | Ulasan hanya untuk order `completed` milik pemanggil + email kampus terverifikasi; satu ulasan per order termasuk yang di-soft-delete; tenant hanya membaca/membalas; moderasi kampus `keep`/`hide` dengan alasan + audit. |
| Isolasi data   | Route publik `GET /api/v1/tenants/:id/reviews` memakai proyeksi tanpa `buyerId`/`orderId`; tidak ada permission baru (memakai `tenant.reviews.reply` dan `campus.reviews.moderate`).                                       |

Bukti: `npm run test:integration` menerapkan migrasi `0000..0010` pada PostgreSQL baru dan menjalankan **411/411 tes** tanpa skip; typecheck, lint, format dan build lulus. API boot bersih dan `/docs` memuat 9 route reviews serta 2 route reporting.

### Slice reporting (read-only)

Laporan penjualan tenant (`GET /api/v1/tenants/:id/reports/sales`, `tenant.sales.read`) dan dashboard pantauan kampus (`GET /api/v1/campuses/:id/dashboard`, `campus.transactions.read`). Detail ada di [modules/reporting.md](modules/reporting.md). Tanpa tabel baru dan tanpa menulis baris: hanya `count` dan penjumlahan kolom yang sudah ada, dikelompokkan per status, dalam jendela `[from, to)` maksimum 366 hari. Definisi gross/net/fee/pajak tetap tidak dikarang karena REQUIREMENTS §3.8.8 belum memutuskannya.

Yang masih terbuka dan **tidak** diklaim selesai:

- Antrean sinyal risiko (mis. lonjakan rating) dan `risk_reviews` — slice `risk` masih scaffold.
- Ekspor laporan (CSV/PDF), penjadwalan laporan, dan read replica/materialized projection untuk volume besar.
- Profil `/me`, dispatcher OTP eksternal, dan job operasional (pembersih idempotency/outbox, penyapu release, retensi/rekonsiliasi).
- Trigger DB penolak saldo negatif akun system (Q6) dan jalur penyelesaian `needs_assistance`.

Tidak ada provider nyata, deployment, atau migrasi produksi yang diklaim.

## Status implementasi 13 November 2026 (lanjutan 5) — prefix `/api/v1` dan panduan API

Perubahan transport dan dokumentasi, tanpa perubahan perilaku bisnis:

- **Prefix global menjadi `/api/v1`** (sebelumnya `/v1`). Diperbarui di `src/main.ts`, pengecualian readiness pada `ApiExceptionFilter`, seluruh test HTTP, probe readiness di `deploy/compose.yaml`, `deploy/remote-deploy.sh`, `.github/workflows/ci.yml` dan `deploy.yml`, serta dokumentasi. Tidak ada route bisnis yang berubah selain prefix.
- **Panduan API untuk agent frontend**: `GET /api/v1/guide` (HTML), `/api/v1/guide.md` (Markdown), `/api/v1/guide/openapi.json`. Dihasilkan saat request dari dokumen OpenAPI yang berjalan sehingga daftar endpoint dan object tidak bisa menyimpang dari kode; konvensi, role/permission, state machine dan daftar "belum tersedia" ditulis di `api-guide.content.ts`. Detail: [modules/api-guide.md](modules/api-guide.md).

Bukti: `npm run test:integration` menerapkan migrasi `0000..0010` pada PostgreSQL baru dan menjalankan **418/418 tes** tanpa skip; typecheck, lint, format dan build lulus. API boot dengan `SWAGGER_ENABLED=true` melayani `/api/v1/health/live`, `/api/v1/guide`, `/api/v1/guide.md` dan `/api/v1/guide/openapi.json` (200), sedangkan `/v1/health/live` sekarang 404.

## Paket kerja dan Jira

| Paket                                  | Tiket backend                                                                                                                                  | Status implementasi                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Protokol/baseline                      | [KAN-64](https://naassyifan-1794411535927.atlassian.net/browse/KAN-64)                                                                         | Approved; dokumentasi/audit awal saja                                                  |
| OTP/sesi/verifikasi                    | [KAN-65](https://naassyifan-1794411535927.atlassian.net/browse/KAN-65)                                                                         | Implementasi diuji; provider/dispatcher dan profil dilanjutkan; belum Live             |
| Scope/permission/staf                  | [KAN-24](https://naassyifan-1794411535927.atlassian.net/browse/KAN-24)                                                                         | Approved; HTTP + PostgreSQL diuji                                                      |
| Schema bertahap                        | [KAN-18](https://naassyifan-1794411535927.atlassian.net/browse/KAN-18)                                                                         | Berjalan lintas slice; bukan satu migrasi seluruh produk                               |
| Katalog/availability                   | [KAN-67](https://naassyifan-1794411535927.atlassian.net/browse/KAN-67)                                                                         | In Design/implementasi; belum diterima                                                 |
| Ledger/wallet                          | [KAN-66](https://naassyifan-1794411535927.atlassian.net/browse/KAN-66)                                                                         | Approved; termasuk konkurensi, rollback, immutable dan API read                        |
| Top-up QRIS sandbox                    | [KAN-29](https://naassyifan-1794411535927.atlassian.net/browse/KAN-29), [KAN-30](https://naassyifan-1794411535927.atlassian.net/browse/KAN-30) | Implementasi wave 2; intent/provider/webhook belum diterima                            |
| Checkout/order/proposal                | [KAN-32](https://naassyifan-1794411535927.atlassian.net/browse/KAN-32)                                                                         | Implementasi wave 2; belum diterima                                                    |
| Pickup/kendala/kasus                   | [KAN-68](https://naassyifan-1794411535927.atlassian.net/browse/KAN-68)                                                                         | Pickup dikerjakan bersama order; kasus menyusul                                        |
| Refund                                 | [KAN-31](https://naassyifan-1794411535927.atlassian.net/browse/KAN-31)                                                                         | Menunggu order/kasus dan adapter sandbox sukses terdeduplikasi                         |
| Settlement/rekening/payout             | [KAN-69](https://naassyifan-1794411535927.atlassian.net/browse/KAN-69)                                                                         | Planned; kebijakan pilot sudah diputuskan, implementasi belum                          |
| Review/risk/notifikasi/audit/reporting | [KAN-70](https://naassyifan-1794411535927.atlassian.net/browse/KAN-70)                                                                         | In Design; slice outbox/notifikasi/audit diuji, review/risk/reporting menyusul         |
| Kontrak OpenAPI                        | [KAN-19](https://naassyifan-1794411535927.atlassian.net/browse/KAN-19)                                                                         | Bertahap bersama controller/DTO; Swagger hanya memuat route yang benar-benar terdaftar |

Referensi shared yang tetap dipertahankan: KAN-22/25/33/34/35/37/50/51/54. Referensi bukan klaim penerimaan backend dan duplikat tidak ditutup otomatis.

## Dependensi dan penerimaan

- Identitas sesi tepercaya mendahului integrasi endpoint permission; schema sendiri tidak mengautentikasi user.
- Checkout membutuhkan katalog server-side, kapasitas dan ledger, seluruhnya satu transaksi PostgreSQL dengan idempotency. Replay diperiksa sebelum re-quote.
- QRIS hanya untuk top-up. Wallet membayar order sebelum tenant menerima/menyiapkan. Provider signature/ref/amount/currency/state dan dedupe harus terbukti.
- Proposal reject/timeout tidak menerima jadwal atau memulai produksi. Pickup hanya order/tenant benar, satu handover.
- Kasus/refund memerlukan keputusan manusia berizin. Hanya provider success tervalidasi membuat kredit refund sekali.
- Settlement/payable berbeda dari payment/order completed; payout tidak melebihi dana tersedia dan hanya pemilik terverifikasi.
- Review hanya order completed dan email kampus verified, unik per order. Risk tidak menjatuhkan sanksi otomatis. Notifikasi tidak memindahkan uang.
- Mutasi kritis wajib audit/outbox atomik dan PostgreSQL tests untuk constraint, scope, replay, rollback serta konkurensi yang relevan.

## Batas keputusan pilot dan produksi

[PILOT-POLICY.md](PILOT-POLICY.md) mengunci keputusan awal atas delegasi pengguna: checkout satu tenant, reservasi saat pembayaran, IDR rupiah bulat, tanpa fee/komisi/pajak tambahan pilot, release payable sesudah handover tanpa kasus terbuka, refund penuh melalui pengelola dan provider success, serta payout sandbox dari dana tersedia ke rekening terverifikasi. Keputusan tersebut menggantikan status TBD untuk pilot saja.

Provider/kredensial nyata, biaya kontraktual/pajak, domain/rekening terverifikasi, chargeback, retensi, backup/restore, monitoring produksi, distribusi aplikasi dan aktivasi finansial nyata tetap membutuhkan integrasi/operasional tersendiri. Stub tidak diizinkan di production. Lihat [REQUIREMENTS-API.md](REQUIREMENTS-API.md) untuk batas prototype dan [ORCHESTRATION.md](ORCHESTRATION.md) untuk assignment, review dan Definition of Done.

Workflow Jira yang tersedia memakai To Do, In Design, User Testing, Approved dan Live. Approved berarti penerimaan sesuai scope dan bukti; Live tidak digunakan untuk menyiratkan deployment yang belum dilakukan. Root membaca transisi sebelum memindahkan issue dan mencatat commit, tes serta keterbatasannya.
