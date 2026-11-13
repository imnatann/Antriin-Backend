# Panduan Agent — Antriin Backend

Panduan ini berlaku untuk seluruh repository `Antriin-Backend`. Baca sebelum mengubah kode. Instruksi pengguna pada pekerjaan yang sedang berlangsung menjadi acuan utama; panduan yang lebih spesifik di subfolder berlaku untuk folder tersebut.

## Acuan proyek

- Baca [README.md](README.md) untuk cara menjalankan proyek dan status implementasinya.
- Baca [docs/REQUIREMENTS-API.md](docs/REQUIREMENTS-API.md) untuk fitur, alur, role, permission, database dan keputusan stack.
- Bedakan requirement yang sudah disepakati, usulan implementasi, dan keputusan yang masih terbuka. Jangan menetapkan fee, settlement, batas refund, atau aturan bisnis finansial baru tanpa dasar kebutuhan pengguna.
- Perbarui dokumentasi dan OpenAPI saat perilaku atau kontrak API berubah. Bila membuat asumsi yang memengaruhi produk, catat secara eksplisit.

## Stack dan struktur

- Node.js **24 LTS**, npm, TypeScript strict, NestJS dengan Fastify adapter.
- PostgreSQL sebagai sumber kebenaran transaksi; Drizzle ORM dan migrasi SQL.
- Redis untuk antrean/cache/rate limit; BullMQ untuk background jobs.
- REST JSON dengan prefix `/api/v1`, OpenAPI/Swagger, logging JSON melalui Pino.
- Arsitektur modular monolith; API dan worker berjalan sebagai proses/container terpisah.
- `src/modules/<domain>/`: controller, DTO, service dan aturan domain terkait.
- `src/database/`: koneksi PostgreSQL, schema Drizzle dan akses database bersama.
- `src/infrastructure/`: integrasi infrastruktur dan lifecycle koneksi.
- `src/jobs/`: konfigurasi queue dan processor; `src/config/`: environment dan logging.
- `drizzle/`: migrasi SQL dan metadata yang ikut disimpan di Git.
- `test/`: pengujian memakai `node:test`, `node:assert` dan utilitas NestJS.

## Status fondasi

Fondasi health telah dilengkapi implementasi OTP/sesi melalui port delivery, verifikasi kampus terpisah, permission granular/membership, wallet/ledger double-entry, audit immutable, serta outbox/notifikasi dalam aplikasi. Adapter OTP default menolak pengiriman; pengiriman eksternal dan uang nyata belum aktif. Order, katalog/availability, pickup, top-up/refund, settlement/payout dan ulasan sudah diimplementasikan; risk dan profil `/me` masih scaffold — jangan menganggap modul scaffold sebagai fitur selesai. Lihat status dan bukti terbaru pada `docs/BACKEND-BACKLOG.md`; keputusan pilot yang didelegasikan pengguna ada di `docs/PILOT-POLICY.md`.

## Cara mengerjakan perubahan

- Periksa kode dan pola yang ada sebelum menambahkan abstraksi atau dependency. Batasi perubahan pada kebutuhan tugas.
- Letakkan aturan bisnis di service domain; controller menangani transport dan validasi. Worker memanggil service domain yang sama untuk perubahan bisnis.
- Validasi DTO saat runtime; tipe TypeScript saja tidak memvalidasi input HTTP. Pertahankan whitelist dan penolakan field yang tidak dikenal.
- Gunakan `ConfigService` dan validasi environment terpusat. Tambahkan variabel baru ke `.env.example` dan README; jangan menimpa `.env` lokal yang telah disesuaikan.
- Pilih plugin yang kompatibel dengan Fastify. Pertahankan konfigurasi compiler dan decorator yang diperlukan NestJS.
- Perbarui `package-lock.json` ketika dependency berubah. Jangan menambah framework/ORM lain atau mengganti stack sebagai efek samping tugas.
- Jalankan format hanya pada file yang berubah bila format seluruh repository akan menyentuh pekerjaan lain.

## Aturan produk yang wajib dijaga

- Pembeli membayar dengan AntriPay sebelum konfirmasi/persiapan tenant. QRIS digunakan untuk top-up.
- Pembayaran sukses, order selesai, settlement tersedia, refund dan payout adalah status/entitas terpisah.
- Usulan perubahan jadwal memerlukan persetujuan pembeli. Timeout atau penolakan tidak boleh otomatis menerima usulan atau memulai produksi.
- Pesanan besar dan indikasi AI menjadi bahan tinjauan manusia; tidak otomatis membuktikan kecurangan atau memicu sanksi.
- Refund menambah saldo hanya setelah hasil sukses terkonfirmasi dan dideduplikasi.
- Pickup harus divalidasi untuk order dan tenant yang benar; serah terima hanya dapat dicatat satu kali.
- Ulasan memerlukan order selesai dan email kampus terverifikasi, unik per order. Tenant tidak dapat menghapus ulasan pembeli.

## Otorisasi dan data sensitif

- Periksa permission dan kepemilikan resource pada server untuk setiap aksi. Scope buyer, tenant dan campus harus diperiksa saat query/mutasi, termasuk background jobs.
- Jangan mempercayai `user_id`, `tenant_id`, role, harga, total, saldo atau status dari klien sebagai otoritas.
- Staf dapur/pengambilan tidak mempunyai akses rekening dan pencairan. Pemilik tenant terverifikasi mengelola fungsi tersebut.
- Jangan commit atau mencetak `.env`, credential, OTP, token, payload provider sensitif atau nomor rekening lengkap. Gunakan hash/tokenisasi/enkripsi dan masking sesuai kebutuhan data.
- Aksi keuangan, perubahan akses dan keputusan pengelola harus menghasilkan audit dengan aktor, target, alasan dan waktu.

## Database dan konsistensi

- Gunakan UUID/ID opaque, timestamp UTC dan timezone lokal eksplisit. Uang memakai integer satuan terkecil beserta currency; hindari floating point dan konversi bigint ke number yang kehilangan presisi.
- Terapkan FK, unique/check constraints dan indeks sesuai pola query. Snapshot harga, nama menu dan opsi order harus tetap utuh setelah katalog berubah.
- Gunakan transaksi PostgreSQL dan locking/optimistic concurrency untuk saldo, kapasitas, status, keputusan proposal dan handover.
- Semua perubahan saldo melalui ledger double-entry yang seimbang dan immutable. Redis/cache bukan sumber kebenaran saldo.
- Mutation kritis, webhook dan job harus idempotent. Provider event/reference dan request key memerlukan constraint deduplikasi yang tepat.
- Jangan menunggu panggilan jaringan provider saat memegang transaksi/row lock. Simpan state dan outbox secara atomik; lakukan integrasi lewat proses terpisah yang dapat diulang.
- Perubahan schema: edit schema Drizzle, jalankan `npm run db:generate`, review SQL, lalu sertakan SQL dan metadata migrasi. Jangan mengubah migrasi yang sudah diterapkan; tambahkan migrasi baru.
- Jalankan migrasi terhadap database development/test yang dituju; jangan mengasumsikan `.env` selalu menunjuk database lokal. Migrasi produksi merupakan langkah deployment terkontrol.
- Jangan reset database, menghapus volume atau menjalankan perubahan destructive sebagai cara rutin memperbaiki masalah. Pertahankan data dan pekerjaan pengguna.
- `updated_at` belum memiliki trigger; mutation aplikasi harus mengaturnya secara eksplisit.

## Queue dan integrasi

- Processor menangani retry/backoff, deduplikasi dan kegagalan permanen secara eksplisit. Retry tidak boleh menggandakan efek finansial atau notifikasi.
- Gunakan transactional outbox untuk publikasi event yang harus konsisten dengan commit database.
- Verifikasi signature webhook dan korelasikan reference, currency, amount dan state sebelum mengubah data.
- Gunakan provider sandbox atau stub terkontrol untuk pengujian; jangan memakai transaksi uang nyata sebagai pemeriksaan rutin.
- Worker mendukung probe `maintenance/healthcheck` dan `domain-events/deliver` untuk notifikasi dalam aplikasi, dengan payload tervalidasi dan deduplikasi PostgreSQL. Delivery OTP memiliki outbox tersendiri; jangan menganggap provider atau dispatcher OTP aktif sebelum integrasinya dibuktikan. Implementasikan job bisnis tambahan beserta penanganan kegagalannya saat fitur dibuat.

## Menjalankan dan memeriksa

Gunakan Node sesuai `.nvmrc`. Install dependency dengan `npm ci`. Buat `.env` dari `.env.example` hanya jika belum ada.

```sh
npm run infra:up
npm run db:migrate
npm run start:dev
# Terminal terpisah:
npm run start:worker:dev
```

Port default lokal: API `3000`, PostgreSQL `5433`, Redis `6380`. Swagger `/docs` aktif bila `SWAGGER_ENABLED=true`. `GET /api/v1/health/live` mengecek proses; `GET /api/v1/health/ready` mengecek koneksi DB dan Redis, mengembalikan `503` bila dependency tidak tersedia.

Untuk perubahan kode, jalankan pemeriksaan yang relevan:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

- Tambahkan test bermakna untuk aturan bisnis yang berubah, jalur gagal, permission/scope, idempotency dan konkurensi bila relevan. Jangan menambah test yang hanya menyalin implementasi.
- Perubahan schema/query/transaksi memerlukan pemeriksaan terhadap PostgreSQL; stub saja tidak membuktikan constraints atau locking.
- Jalankan pemeriksaan integrasi menggunakan PostgreSQL/Redis lokal atau service CI. Jika infrastruktur tidak tersedia, laporkan pemeriksaan yang belum dapat dijalankan secara spesifik.
- Untuk perubahan dokumentasi saja, periksa tautan, konsistensi isi dan formatting; tidak perlu menjalankan seluruh test aplikasi.
- Jangan menjalankan `npm audit fix --force` tanpa meninjau perubahan dependency dan kompatibilitasnya.

## Pelaporan hasil

Sampaikan perubahan utama, file yang relevan, hasil pemeriksaan yang benar-benar dijalankan, dan hal yang belum selesai. Jangan menyatakan integrasi, migrasi, Docker build, atau CI berhasil tanpa bukti eksekusi. Bedakan fitur siap digunakan dari scaffold dan mock.

## Orkestrasi subagent

Untuk pekerjaan yang didelegasikan, gunakan protokol repo di [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md). Penugasan subagent dibatasi pada model Luna (`gpt-6-luna`), brief mandiri, dan scope/file yang ditetapkan root; jangan melakukan nested delegation tanpa arahan root. Root mengoordinasikan integrasi, review terpisah, penerimaan, serta perubahan Jira backend-only. Panduan ini berlaku untuk orkestrasi dalam sesi kerja, bukan konfigurasi global Codex.
