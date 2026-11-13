# Deployment — backend pilot

Auto-deploy ke satu host pilot. Workflow: [.github/workflows/deploy.yml](../.github/workflows/deploy.yml).

## Alur

1. Push ke `main` → [ci.yml](../.github/workflows/ci.yml) menjalankan typecheck, lint, format, migrasi, seluruh tes pada PostgreSQL 17 + Redis 7 nyata, build, dan probe `/api/v1/health/ready`.
2. Bila CI **sukses**, `deploy.yml` terpicu lewat `workflow_run`.
3. Job `build` membangun dua image dan push ke GHCR:
   - `ghcr.io/<owner>/antriin-backend:<sha>` (target `runtime`)
   - `ghcr.io/<owner>/antriin-backend:<sha>-migrator` (target `migrator`, membawa `drizzle-kit` yang merupakan devDependency)
4. Job `deploy` menyalin [compose.yaml](compose.yaml) dan [remote-deploy.sh](remote-deploy.sh) ke `/opt/antriin`, lalu menjalankan:
   pull image → `docker compose up -d postgres redis` → `docker compose run --rm migrate` → `up -d api worker` → tunggu `/api/v1/health/ready` → verifikasi endpoint publik.
5. Bila readiness gagal, script **rollback** ke image sebelumnya (`docker inspect` pada `antriin-api-1`) lalu keluar dengan status gagal.

Deploy tidak pernah berjalan paralel (`concurrency: deploy-production`, `cancel-in-progress: false`) supaya stack tidak tertinggal setengah jadi.

## GitHub Secrets

| Secret           | Isi                                              |
| ---------------- | ------------------------------------------------ |
| `DEPLOY_HOST`    | alamat host pilot                                |
| `DEPLOY_USER`    | user SSH untuk deploy                            |
| `DEPLOY_SSH_KEY` | private key ed25519 khusus CI (tanpa passphrase) |

`GITHUB_TOKEN` dipakai untuk push ke GHCR dan untuk `docker login` sementara di host; setelah deploy selesai host selalu `docker logout` (langkah `if: always()`).

## Tata letak host

```
/opt/antriin/
├── compose.yaml        # disalin dari repo setiap deploy
├── remote-deploy.sh    # disalin dari repo setiap deploy
└── .env                # HANYA di host, mode 600, tidak pernah di-commit
```

`.env` dibuat sekali oleh [provision-env.sh](provision-env.sh). Script itu **idempotent**: bila `.env` sudah ada, isinya tidak disentuh sehingga redeploy tidak merotasi secret.

```sh
scp deploy/provision-env.sh root@HOST:/tmp/ && ssh root@HOST 'bash /tmp/provision-env.sh'
```

Secret yang digenerate: `POSTGRES_PASSWORD`, `AUTH_SECRET` (hex 32 byte), `AUTH_ENCRYPTION_KEY` (base64 tepat 32 byte, sesuai validator Joi). Semuanya dibuat di host dengan `openssl`, bukan dari mesin developer.

## Menjalankan manual

```sh
gh workflow run Deploy --repo imnatann/Antriin-Backend
```

Atau di host, tanpa CI:

```sh
cd /opt/antriin
docker login ghcr.io -u <user> --password-stdin   # butuh token read:packages
IMAGE=ghcr.io/<owner>/antriin-backend TAG=<sha> bash remote-deploy.sh
```

## Endpoint

| Path                   | Kegunaan                              |
| ---------------------- | ------------------------------------- |
| `/api/v1/health/live`  | proses hidup                          |
| `/api/v1/health/ready` | PostgreSQL + Redis terjangkau         |
| `/docs`                | Swagger (aktif via `SWAGGER_ENABLED`) |

API di-bind ke `0.0.0.0:3000` lewat `API_BIND_ADDRESS`.

## Status terverifikasi (13 Nov 2026)

Deploy berjalan end-to-end dan diverifikasi dari internet publik.

### Deploy terakhir — commit `9eb17c2`

| Pemeriksaan                                   | Hasil                                                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| CI                                            | [run 43390996820](https://github.com/imnatann/Antriin-Backend/actions/runs/43390996820) sukses |
| Deploy workflow                               | [run 43391160350](https://github.com/imnatann/Antriin-Backend/actions/runs/43391160350) sukses |
| Image berjalan                                | `ghcr.io/imnatann/antriin-backend:9eb17c2ece4b`                                                |
| `antriin-api-1`                               | Up, healthy                                                                                    |
| `antriin-worker-1`                            | Up                                                                                             |
| `GET /api/v1/health/live`                     | 200                                                                                            |
| `GET /api/v1/health/ready`                    | 200, database & redis true                                                                     |
| `GET /api/v1/guide` (+`.md`, `/openapi.json`) | 200, 109 operasi / 89 path / 47 object                                                         |
| `GET /docs`                                   | 200, Swagger                                                                                   |
| `GET /v1/health/live`                         | 404 — prefix lama sudah tidak dilayani                                                         |
| Migrasi `0000..0010`                          | 11 entri, 55 tabel (termasuk 4 tabel ulasan)                                                   |

### Deploy pertama — commit `284e0d5`

| Pemeriksaan                   | Hasil                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| CI pada commit yang di-deploy | sukses, termasuk 384 tes                                                                       |
| Deploy workflow               | [run 43377553948](https://github.com/imnatann/Antriin-Backend/actions/runs/43377553948) sukses |
| Image berjalan                | `ghcr.io/imnatann/antriin-backend:2520c1ec66f7`                                                |
| `antriin-api-1`               | Up, healthy                                                                                    |
| `antriin-worker-1`            | Up, worker started                                                                             |
| `GET /api/v1/health/live`     | 200, status ok                                                                                 |
| `GET /api/v1/health/ready`    | 200, database & redis true                                                                     |
| `GET /docs`                   | 200, Swagger                                                                                   |
| Migrasi `0000..0009`          | diterapkan service `migrate` sebelum restart                                                   |

### Jebakan yang sudah ditutup

Dua kegagalan deploy pertama berasal dari workflow, bukan dari aplikasi:

1. `jobs.<id>.environment.url` tidak boleh memakai konteks `secrets`. Itu membuat seluruh file workflow invalid sehingga run muncul tanpa job. `url` dihapus; endpoint diverifikasi oleh langkah `curl` terakhir.
2. Script remote semula dikirim lewat `ssh ... bash -s < script`. `docker compose run` mewarisi stdin dan menelan sisa script: migrasi selesai, script mencapai EOF, keluar 0, dan `api`/`worker` tidak pernah dinyalakan. Sekarang script dijalankan dari file di host dan perintah migrasi diberi `</dev/null`.

## Batas yang belum diklaim

- **Tanpa TLS dan tanpa reverse proxy.** Port 3000 terbuka langsung. Pasang nginx + sertifikat sebelum dipakai pengguna nyata.
- **SSH masih `root` dengan password aktif.** Kunci deploy sudah terpasang, tetapi `PasswordAuthentication` belum dimatikan agar tidak terjadi lockout. Matikan setelah kunci diverifikasi dan password dirotasi.
- `CORS_ORIGINS` masih menunjuk alamat host; ganti ke origin frontend sebenarnya.
- Provider pembayaran/payout/refund tetap `disabled` — production menolak mode sandbox.
- Belum ada backup/restore PostgreSQL otomatis, monitoring, maupun rotasi secret terjadwal.
