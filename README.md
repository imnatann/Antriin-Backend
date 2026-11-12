# Antriin Backend

Fondasi API Antriin: TypeScript, NestJS + Fastify, PostgreSQL + Drizzle, Redis + BullMQ, Swagger dan Docker. Requirements lengkap ada di [docs/REQUIREMENTS-API.md](docs/REQUIREMENTS-API.md).

## Persiapan

- Node.js 24 LTS (lihat `.nvmrc`), npm, Docker Desktop beserta Compose.
- Jika memakai nvm: `nvm install && nvm use`.
- Perintah dijalankan dari folder `Antriin-Backend`.

```sh
npm ci
cp .env.example .env
npm run infra:up
npm run db:migrate
npm run start:dev
```

Pada setup awal `.env` sudah dibuat secara lokal. Jangan menimpa jika sudah disesuaikan. Kredensial Compose adalah contoh development lokal; gunakan secret terpisah untuk deployment.

Buka Swagger di http://localhost:3000/docs. API memakai prefix `/v1`:

- `GET /v1/health/live`: proses API hidup, tanpa memerlukan database/Redis.
- `GET /v1/health/ready`: `200` hanya bila PostgreSQL dan Redis dapat diakses; `503` bila dependency belum siap. Tidak mengecek status migrasi.

Di terminal lain, jalankan worker:

```sh
npm run start:worker:dev
```

Port lokal: API `3000`, PostgreSQL `5433`, Redis `6380`. CORS default mengizinkan frontend `http://localhost:3001`; ubah `CORS_ORIGINS` (daftar dipisah koma) bila perlu.

Jika Docker belum tersedia, install dan jalankan Docker Desktop dahulu. API tetap dapat membuka health/live dan Swagger; readiness akan `503` sampai PostgreSQL/Redis tersedia. Worker membutuhkan Redis.

## Menjalankan aplikasi dalam Docker

Setelah `.env` tersedia dan migrasi diterapkan pada database lokal:

```sh
npm run infra:up
npm run db:migrate
docker compose --profile app up --build -d
```

API dan worker menggunakan image yang sama dengan entry point terpisah. Compose mengganti alamat DB/Redis ke nama service container. Konfigurasi Compose ditujukan untuk development lokal.

## Database

Skema awal mencakup `campuses`, `users`, dan `tenants` dengan UUID, timestamp UTC, FK, indeks dan constraints status. Ini fondasi, belum keseluruhan schema produk. Update `updated_at` secara eksplisit di mutation aplikasi; kolom tersebut belum memakai trigger.

```sh
# Setelah mengubah src/database/schema:
npm run db:generate
# Review SQL dan commit file migrasi, lalu:
npm run db:migrate
# Opsional, UI database lokal:
npm run db:studio
```

Migrasi dijalankan satu kali sebagai langkah deployment terkontrol. Jangan menjalankan `push` otomatis atau migrasi serentak dari tiap replica API. Jangan hapus volume Compose untuk mereset data tanpa backup.

## Struktur

```text
src/
  config/             Validasi environment dan logging
  database/           Pool PostgreSQL, Drizzle, schema
  infrastructure/     Klien Redis dan lifecycle
  jobs/               Konfigurasi BullMQ dan worker maintenance
  modules/            Modul domain sesuai requirements
  app.module.ts       Komposisi API
  main.ts             HTTP bootstrap
  worker.module.ts    Komposisi worker
  worker.ts           Worker bootstrap
```

Modul domain telah diregistrasi sebagai scaffold. Auth/OTP, RBAC, order, saldo/ledger, top-up, refund, payout, AI dan notifikasi bisnis **belum diimplementasikan**. Endpoint aktif hanya health; konfigurasi bearer authentication akan ditambahkan bersama modul auth. Worker hanya menerima job probe `maintenance/healthcheck` dan menolak nama job lain; belum memproses uang atau pesanan. Queue producer dapat mengimpor `JobsModule` ketika fitur terkait mulai dibuat.

Log menggunakan JSON Pino dengan redaksi authorization/cookie. Jangan menambahkan OTP, token, payload provider atau data rekening mentah ke log. Request ID log disediakan Pino; idempotency, outbox dan standar respons domain mengikuti tahap implementasi berikutnya.

## Pemeriksaan

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm start
# Build dulu sebelum menjalankan worker production:
npm run start:worker
```

Test health menguji status HTTP siap/tidak siap dan kegagalan masing-masing dependency memakai stub terkontrol. CI juga menjalankan migrasi ke PostgreSQL sementara dan probe readiness dengan Redis. Health test tidak membuktikan integrasi finansial yang belum dibuat.

Gunakan `npm run infra:down` untuk menghentikan service tanpa menghapus volume. `.env`, dependencies dan hasil build diabaikan Git. Versi dependency dikunci melalui `package-lock.json`.

Audit dependency production saat setup tidak menemukan vulnerability. Audit lengkap masih mencatat 14 temuan moderate pada dependency tooling development (rantai Drizzle Kit/esbuild dan ESLint/minimatch). Pantau update upstream; jangan menjalankan `npm audit fix --force` tanpa review karena rekomendasinya dapat mengganti major version atau menurunkan Drizzle Kit.

Referensi: [NestJS/Fastify](https://docs.nestjs.com/techniques/performance), [NestJS queues](https://docs.nestjs.com/techniques/queues), [Drizzle](https://orm.drizzle.team/docs/transactions).

## Pengembangan dengan agent

Root orchestrator membagi pekerjaan backend kepada subagent **GPT-6 Luna**, menetapkan kepemilikan file, mengoordinasikan review terpisah dan memperbarui Jira sesuai bukti. Protokol dan template penugasan ada di [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md); urutan implementasi, pemetaan tiket dan keputusan yang masih terbuka ada di [docs/BACKEND-BACKLOG.md](docs/BACKEND-BACKLOG.md).
