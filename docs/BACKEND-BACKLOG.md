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
