# Modul API Guide

Halaman panduan API yang dibaca agent AI (atau manusia) sebelum mengimplementasikan frontend. Bukan dokumentasi kedua yang ditulis tangan: **daftar endpoint dan object dihasilkan saat request dari dokumen OpenAPI yang sedang berjalan**, jadi tidak bisa menyimpang dari kode.

## Endpoint

Ketiganya hanya terdaftar bila `SWAGGER_ENABLED=true`. Tanpa itu, semuanya 404 seperti path yang tidak ada.

| Method | Path                         | Isi                                                                 |
| ------ | ---------------------------- | ------------------------------------------------------------------- |
| GET    | `/api/v1/guide`              | Halaman HTML lengkap (dibaca manusia dan agent lewat fetch/browser) |
| GET    | `/api/v1/guide.md`           | Versi Markdown — bentuk paling hemat token untuk agent              |
| GET    | `/api/v1/guide/openapi.json` | Dokumen OpenAPI mentah yang sama dengan sumber Swagger UI           |

Tidak ada autentikasi: isinya sama dengan `/docs` yang sudah publik saat `SWAGGER_ENABLED=true`. Jangan aktifkan Swagger di production terbuka; kalau perlu, batasi lewat reverse proxy.

## Isi halaman

1. **Autentikasi** — alur OTP, sesi opaque, rotasi/revoke, verifikasi email kampus, rate limit.
2. **Konvensi respons** — envelope `{data, meta}`, envelope error beserta tabel status/kode, timestamp mikrodetik, uang sebagai string, pagination cursor, aturan idempotency.
3. **Role dan permission** — matriks role tenant (`owner`/`kitchen`/`pickup`), daftar permission kampus, daftar route publik.
4. **Alur dan state machine** — order, usulan jadwal, kasus/refund, settlement/payout, ulasan.
5. **Belum tersedia** — daftar tegas fitur yang **tidak boleh** dibangun dulu (profil `/me`, risk/AI, ekspor laporan, provider nyata, upload file, push, WebSocket).
6. **Endpoint** — per tag: method, path, penanda bearer/publik, parameter (path/query/header) beserta tipe dan batasnya, body, dan setiap status respons. Envelope `{data}` dilepas otomatis supaya field payload tetap terlihat.
7. **Objects** — setiap schema komponen dengan field, tipe, wajib/tidak, batas (range/panjang/jumlah) dan deskripsi.

## Sumber kebenaran

- **Dihasilkan dari OpenAPI** (`api-guide.service.ts`): daftar endpoint, parameter, body, respons, semua object, dan prefix dasar (dihitung dari path bersama, saat ini `/api/v1`).
- **Ditulis manual** (`api-guide.content.ts`): hanya hal yang tidak bisa dinyatakan dokumen OpenAPI — konvensi, semantik role/permission, aturan state, dan batas "belum tersedia".

Karena itu, mengubah controller/DTO otomatis memperbarui halaman. Mengubah aturan produk (mis. permission baru, alur baru) wajib disertai pembaruan `api-guide.content.ts`.

## Wiring

`src/main.ts` membuat dokumen sekali saat bootstrap lalu menyerahkannya ke `ApiGuideService.setDocument()`. Sebelum itu, setiap route guide menjawab 404 — perilaku ini diuji, jadi `SWAGGER_ENABLED=false` tidak membocorkan apa pun.

## Pemeriksaan

`test/api-guide.spec.ts` menguji: guide tertutup sebelum dokumen terdaftar, endpoint/parameter/respons/object benar-benar diturunkan dari dokumen, envelope dilepas, prefix tidak dobel, HTML ter-escape, ketiga route melayani di bawah `/api/v1`, dan 404 saat dokumen tidak ada.
