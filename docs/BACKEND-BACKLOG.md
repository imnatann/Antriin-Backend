# Backend Backlog — Antriin

**Baseline: 12 November 2026.** Dokumen ini mencatat keadaan backend dan urutan kerja yang disarankan. Requirements API menjadi sumber aturan produk; backlog ini tidak menetapkan keputusan finansial yang masih terbuka. Paket yang belum memiliki issue backend khusus berstatus **planned** dan perlu dipecah menjadi tiket saat siap dikerjakan. Jangan mengarang key Jira.

## Baseline implementasi

Fakta per tanggal baseline:

- Backend adalah fondasi NestJS/Fastify. Endpoint bisnis belum aktif; endpoint HTTP yang tersedia hanya health: `GET /v1/health/live` dan `GET /v1/health/ready`.
- Schema Drizzle/migrasi awal berisi tiga tabel: `campuses`, `users`, dan `tenants`.
- Worker hanya mendukung probe `maintenance/healthcheck`; belum memproses order atau transaksi.
- Modul bisnis telah terdaftar sebagai scaffold, tetapi auth, access/RBAC, katalog, availability, order, wallet/ledger, payments, refund, settlement, payout, case, pickup, review, risk, notifikasi bisnis, audit, dan reporting belum diimplementasikan.
- Scope perubahan hari ini hanya dokumentasi, AGENTS, dan Jira. Belum ada fitur bisnis yang diimplementasikan.

### Pemeriksaan baseline

Audit menggunakan Node **24.22.2** dengan versi tersebut diarahkan ke `PATH`; Node default shell **26.13** tidak sesuai rentang proyek. Dependency tersedia. Hasil pemeriksaan yang dijalankan:

| Pemeriksaan            | Hasil                 |
| ---------------------- | --------------------- |
| `npm run typecheck`    | PASS                  |
| `npm run lint`         | PASS                  |
| `npm run format:check` | PASS                  |
| `npm test`             | PASS — 4/4 tes health |
| `npm run build`        | PASS                  |

PostgreSQL/Redis lokal, migrasi, readiness end-to-end, dan CI run **tidak dijalankan** dalam audit ini. Membaca konfigurasi workflow hanya membuktikan konfigurasi yang tercatat, bukan bahwa CI telah lulus. Hasil health dan build tidak membuktikan integrasi atau aturan bisnis finansial.

## Urutan paket kerja

Urutan berikut mencerminkan dependensi domain. Paket yang belum punya issue backend tersendiri tetap **planned**. Tiket implementasi backend berstatus **To Do** pada baseline ini; KAN-64 berstatus **Approved** setelah dokumentasi dan review diterima root.

Dependency `Blocks` Jira yang dibuat untuk gate implementasi: KAN-65 → KAN-24; KAN-24 → KAN-32; KAN-66 → KAN-29, KAN-30, KAN-32, dan KAN-31; KAN-29 → KAN-30; KAN-32 → KAN-31. Dependency ini mengurutkan implementasi/penerimaan fitur yang membutuhkan fondasi tersebut; pekerjaan desain dan penetapan kontrak dapat berlangsung paralel.

### 1. Protokol implementasi dan baseline backend

**Status:** Approved. **Issue:** [KAN-64 — protokol/audit baseline](https://naassyifan-1794411535927.atlassian.net/browse/KAN-64), parent KAN-4.

**Cakupan:** dokumentasikan baseline, cara kerja, gates, batas backend-only, dan keputusan yang masih terbuka. Paket ini menjadi prasyarat koordinasi dan penerimaan.

**Acceptance ringkas:** dokumen baseline final berada di repo; hasil pemeriksaan dan keterbatasan dibedakan jelas; scope dan dependency paket berikut tercatat; review independen selesai. Root menerima hasil dan memperbarui KAN-64 ke **Approved**. Formatting empat file dokumentasi dan sembilan tautan Markdown lokal lulus; penerimaan ini tidak menyatakan fitur bisnis atau deployment selesai.

### 2. Identitas, sesi, dan otorisasi

**Status:** To Do. **Issue:** [KAN-65 — auth backend API](https://naassyifan-1794411535927.atlassian.net/browse/KAN-65), Subtask KAN-22; [KAN-24 — permission buyer/owner/kitchen/pickup/campus](https://naassyifan-1794411535927.atlassian.net/browse/KAN-24). Schema foundation terkait: [KAN-18 — desain schema bertahap](https://naassyifan-1794411535927.atlassian.net/browse/KAN-18).

**Cakupan:** OTP/sesi, akun, verifikasi email kampus, role/permission, membership dan scope per aksi/resource. Simpan OTP secara aman, lindungi dari enumeration/brute force, dan audit perubahan akses. Buyer, tenant, dan campus scope harus ditegakkan di server; kitchen/pickup tidak mendapat akses rekening/payout.

**Acceptance ringkas:** input tervalidasi; sesi dan verifikasi email memiliki state terpisah; uji izin dan akses lintas-owner/tenant/campus menolak akses yang tidak berhak; perubahan akses tercatat dengan aktor dan waktu.

**Dependensi:** protokol/baseline paket 1; fondasi schema KAN-18. KAN-24 harus menentukan izin secara granular tanpa memperluas akses staf keuangan.

### 3. Katalog dan availability

**Status:** planned; belum ada tiket backend khusus yang ditetapkan. Referensi shared: [KAN-25](https://naassyifan-1794411535927.atlassian.net/browse/KAN-25), [KAN-35](https://naassyifan-1794411535927.atlassian.net/browse/KAN-35), [KAN-37](https://naassyifan-1794411535927.atlassian.net/browse/KAN-37). Referensi ini bukan penugasan backend dan bukan bukti pekerjaan selesai.

**Cakupan:** tenant/menu/opsi, jam operasional, status buka/jeda, slot pickup, kapasitas, dan ketersediaan item. Server memvalidasi harga dan ketersediaan saat quote/checkout serta mempertahankan snapshot katalog pada order.

**Acceptance ringkas:** akses katalog management dibatasi ke scope/permission yang tepat; item sold-out, tenant tutup/jeda, atau slot penuh tidak dapat dipesan; perubahan katalog tidak mengubah snapshot transaksi lama.

**Dependensi:** auth/access paket 2 dan schema KAN-18. Keputusan produk terkait stok, cutoff, dan reservasi slot harus dicatat sebelum checkout.

### 4. Wallet, ledger, dan top-up

**Status:** To Do. **Issue:** [KAN-66 — wallet double-entry ledger](https://naassyifan-1794411535927.atlassian.net/browse/KAN-66), Task pada epic KAN-7; [KAN-29 — QRIS untuk top-up](https://naassyifan-1794411535927.atlassian.net/browse/KAN-29); [KAN-30 — webhook, deduplikasi dan rekonsiliasi top-up](https://naassyifan-1794411535927.atlassian.net/browse/KAN-30).

**Cakupan:** ledger double-entry immutable sebagai sumber kebenaran, projection saldo yang dapat direkonsiliasi, transaksi idempotent, dan alur top-up QRIS. KAN-66 menangani schema/service ledger dan posting; KAN-29 menangani top-up provider. QRIS adalah metode top-up AntriPay, bukan gateway pembayaran checkout order.

**Acceptance ringkas:** debit/kredit seimbang dan tersimpan atomik; saldo tidak diubah tanpa entri ledger; retry/provider event duplikat tidak menggandakan kredit; webhook tervalidasi terhadap signature, reference, amount, currency, dan state; hanya status sukses terkonfirmasi yang mengkredit wallet. Uji constraint/locking memerlukan PostgreSQL.

**Dependensi:** auth/access paket 2 dan desain schema KAN-18. Provider, nominal, fee, expiry, dan aturan rekonsiliasi operasional tetap TBD.

### 5. Order, pembayaran wallet, proposal, dan kontrak API

**Status:** To Do. **Issue:** [KAN-32 — pemisahan status order/payment/refund, proposal, dan handover](https://naassyifan-1794411535927.atlassian.net/browse/KAN-32); [KAN-19 — OpenAPI](https://naassyifan-1794411535927.atlassian.net/browse/KAN-19); [KAN-18 — desain schema bertahap](https://naassyifan-1794411535927.atlassian.net/browse/KAN-18). KAN-18 adalah umbrella desain schema; implementasi ledger berada pada KAN-66.

**Cakupan:** quote/checkout dengan server menghitung ulang total, validasi menu/slot, reservasi kapasitas, debit wallet, snapshot order, state pembayaran dan outbox dalam transaksi yang sesuai. Status payment dan order terpisah. Tenant hanya menerima/menyiapkan order yang sudah dibayar. Proposal jadwal memerlukan keputusan pembeli; timeout/penolakan tidak menerima proposal atau memulai produksi. Kontrak API dan error/idempotency didokumentasikan di OpenAPI.

**Acceptance ringkas:** gagal di satu langkah checkout tidak meninggalkan debit/order/reservasi parsial; retry tidak membuat debit/order ganda; perubahan harga/ketersediaan/kapasitas diperiksa ulang server; transition illegal dan keputusan proposal replay ditolak; OpenAPI sesuai perilaku dan memuat respons/error yang relevan.

**Dependensi:** paket 3 dan 4. Kebijakan keranjang multi-tenant, cart/slot expiry, formula harga/fee/pajak, limit pembelian, serta batas waktu tenant menerima/menolak belum diputuskan.

### 6. Pickup, kendala, dan refund

**Status:** To Do untuk refund pada [KAN-31 — kredit refund hanya setelah provider sukses](https://naassyifan-1794411535927.atlassian.net/browse/KAN-31); pickup/notifikasi terkait [KAN-33](https://naassyifan-1794411535927.atlassian.net/browse/KAN-33) adalah referensi shared, bukan tiket backend yang ditugaskan atau bukti selesai. Case/cancellation backend khusus: planned.

**Cakupan:** validasi kode pickup terhadap tenant/order/status, handover satu kali, laporan kendala dan review manusia, serta lifecycle refund terhubung ke payment/order asli. Kredit wallet hanya pada konfirmasi sukses provider dan deduplikasi. Jangan otomatis membatalkan order berbayar karena webhook terlambat atau error; arahkan ke state bantuan/reconciliation yang dapat ditinjau.

**Acceptance ringkas:** kode tenant/order salah, state tidak valid, replay, atau role tanpa izin ditolak; handover idempotent dan tercatat satu kali; refund event duplikat tidak membuat kredit ganda; gagal/pending provider tidak mengkredit saldo; semua keputusan case/refund memiliki aktor, alasan, target, dan waktu.

**Dependensi:** paket 5 dan pembayaran/order yang dapat direkonsiliasi. Format/umur kode pickup, no-show, keterlambatan, eligibility refund, batas waktu bantuan, partial/full policy, SLA pengelola, bukti, dan reversal provider tetap TBD.

### 7. Settlement, keuangan tenant, dan payout

**Status:** planned; belum ada tiket backend khusus yang ditetapkan.

**Cakupan:** setelah aturan produk disetujui, modelkan dana paid, order completed, payable/settled, refunded, dan paid out secara terpisah; fungsi rekening/payout hanya untuk pemilik tenant terverifikasi. Rekonsiliasi harus dapat membuktikan saldo dan status keuangan.

**Acceptance ringkas:** status dan ringkasan tidak menyamakan payment success dengan dana tersedia; payout tidak dapat melebihi payable; staff kitchen/pickup tidak dapat mengakses rekening atau payout; retry provider tidak menggandakan mutasi; hasil dapat direkonsiliasi ke ledger.

**Dependensi:** ledger paket 4, order/refund paket 5–6, serta keputusan eksplisit tentang payable/hold/reserve, provider, jadwal, batas nominal, fee, rekening, dispute dan chargeback. Jangan implementasikan aturan settlement atau payout produksi sebelum keputusan tersebut tersedia.

### 8. Review, risk, notifikasi, audit lanjutan, dan reporting

**Status:** planned untuk backend; referensi shared: [KAN-34 — reviews](https://naassyifan-1794411535927.atlassian.net/browse/KAN-34), [KAN-33 — pickup/notifikasi](https://naassyifan-1794411535927.atlassian.net/browse/KAN-33), serta overlap shared [KAN-50](https://naassyifan-1794411535927.atlassian.net/browse/KAN-50), [KAN-51](https://naassyifan-1794411535927.atlassian.net/browse/KAN-51), [KAN-54](https://naassyifan-1794411535927.atlassian.net/browse/KAN-54). Referensi shared bukan penugasan backend, bukan bukti selesai, dan duplikat tidak ditutup otomatis.

**Cakupan:** review mensyaratkan order selesai dan email kampus terverifikasi, unik per order; tenant tidak dapat menghapus review. Risk signal hanya mendukung tinjauan manusia dan tidak memicu sanksi otomatis. Notifikasi memakai outbox/retry/deduplikasi; audit keputusan dan reporting menerapkan scope permission.

**Acceptance ringkas:** review invalid/duplikat dan moderasi oleh role tanpa izin ditolak; risk signal tidak mengubah status atau menjatuhkan sanksi; semua keputusan pengelola tercatat; notifikasi retry tidak menggandakan efek; laporan dibatasi sesuai scope dan data freshness dinyatakan.

**Dependensi:** paket 2 untuk scope/identitas; paket 5–6 untuk status order/review; outbox/event domain dari paket-paket sebelumnya. Provider notifikasi, threshold/version risk, retensi data, kanal realtime, dan scope pelaporan tetap TBD.

## Keputusan produk yang masih terbuka

Daftar ini mengikuti [REQUIREMENTS-API.md](REQUIREMENTS-API.md), terutama bagian 12. Jangan mengubahnya menjadi default implementasi tanpa keputusan produk:

- Harga layanan/komisi, pajak, biaya QRIS/top-up/payout, pembulatan, dan penanggung fee.
- Kapan pembayaran menjadi payable tenant; reserve/hold; batas dan jadwal payout; provider/rekening; dispute/chargeback.
- Checkout lintas tenant, cart expiry, reservasi slot, stok/partial availability, dan deadline respons tenant.
- Pembatalan buyer, no-show, keterlambatan pickup, order ditolak tenant, refund parsial/penuh/setelah pickup, bantuan, SLA pengelola, bukti dan reversal bila provider gagal.
- Provider dan kanal OTP, masa berlaku OTP/session, format/expiry pickup code, serta domain kampus terverifikasi.
- Threshold/model, penjelasan, retensi dan banding untuk risk signal; keputusan manusia tetap wajib.
- Matriks final permission staf/admin, pagination/filter, rate limit, realtime, upload, reporting/retensi PII dan timezone/cutoff kampus.
- Provider pembayaran, payout, notifikasi dan penyimpanan bukti.

Aturan yang tidak terbuka dan harus dipertahankan: order dibayar melalui AntriPay sebelum tenant menerima/menyiapkan; pembayaran, penyelesaian order, settlement, refund dan payout adalah state/entitas berbeda; proposal perubahan jadwal perlu persetujuan pembeli; sinyal risiko memerlukan tinjauan manusia; refund baru mengkredit saldo setelah sukses provider terkonfirmasi dan dideduplikasi; pickup tervalidasi untuk tenant/order dan hanya sekali; review memerlukan order selesai serta email kampus terverifikasi.

## Cara menggunakan backlog

- Gunakan [ORCHESTRATION.md](ORCHESTRATION.md) untuk Definition of Ready/Done, kepemilikan file, review independen, pelaporan pemeriksaan, dan batas perubahan Jira backend-only.
- Transisi Jira yang diamati pada KAN-64: **To Do**, **In Design**, **User Testing**, **Approved**, **Live**; tidak ada transisi `Done`. Tiket implementasi backend masih **To Do**; root memindahkan KAN-64 ke **Approved** setelah file final dan review diterima. Root membaca transisi yang tersedia untuk setiap issue sebelum mengubah status. `Live` tidak digunakan untuk penerimaan dokumentasi baseline atau menyiratkan deployment yang belum dijalankan.
- Jangan mengubah shared epic, issue frontend, atau menutup kemungkinan duplikat KAN-50/51/54 secara otomatis.
- Untuk perubahan schema/transaksi, review migrasi SQL dan verifikasi PostgreSQL; stub saja tidak membuktikan constraint atau locking. Laporkan pemeriksaan yang tidak dijalankan secara spesifik.
- Perbarui baseline dan tautan issue saat implementasi benar-benar berubah. Bedakan fitur aktif, scaffold, mock, planned, dan blocked.
