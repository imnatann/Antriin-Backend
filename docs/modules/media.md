# Modul Media (unggah gambar)

Penyimpanan gambar untuk foto menu, logo/cover tenant, avatar dan bukti kasus. Berkas ditulis ke **disk lokal** di bawah `MEDIA_ROOT`; PostgreSQL menyimpan metadata dan menjadi satu-satunya penentu apakah sebuah berkas bisa diakses.

Modul ini **tidak** menulis ke tabel domain lain. Ia hanya menyimpan berkas dan mengembalikan URL; kewenangan menempelkan gambar ke menu atau kasus tetap diperiksa endpoint masing-masing.

## Endpoint

| Method | Path                   | Auth   | Keterangan                   |
| ------ | ---------------------- | ------ | ---------------------------- |
| GET    | `/api/v1/media/limits` | —      | Batas unggah yang diiklankan |
| POST   | `/api/v1/media`        | bearer | Unggah satu gambar           |
| GET    | `/api/v1/media/{id}`   | —      | Unduh/lihat gambar           |
| DELETE | `/api/v1/media/{id}`   | bearer | Hapus lunak milik sendiri    |

Baca bersifat publik karena tujuan menyimpan gambar adalah menampilkannya kepada pembeli. Unggah butuh token karena setiap aset mencatat pemiliknya.

## `GET /media/limits`

```json
{
  "data": {
    "maxBytes": 5242880,
    "contentTypes": ["image/jpeg", "image/png", "image/webp"],
    "purposes": [
      "menu_item",
      "tenant_logo",
      "tenant_cover",
      "avatar",
      "case_evidence"
    ]
  }
}
```

Klien sebaiknya memanggil ini sekali dan menyimpan hasilnya, agar bisa menolak berkas kebesaran sebelum mengirim.

## `POST /media`

`multipart/form-data` dengan **satu part bernama `file`**. `purpose` dikirim sebagai query, bukan field form, supaya divalidasi deklaratif oleh `ValidationPipe` global.

| Query     | Wajib | Nilai                                                                 |
| --------- | ----- | --------------------------------------------------------------------- |
| `purpose` | ya    | `menu_item`, `tenant_logo`, `tenant_cover`, `avatar`, `case_evidence` |

```bash
curl -X POST "$API/api/v1/media?purpose=menu_item" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@nasi-goreng.jpg;type=image/jpeg"
```

```json
{
  "data": {
    "id": "0b6f…",
    "purpose": "menu_item",
    "url": "/api/v1/media/0b6f…",
    "contentType": "image/jpeg",
    "byteSize": 184320,
    "width": 1024,
    "height": 768,
    "checksumSha256": "9f2c…",
    "originalFilename": "nasi-goreng.jpg",
    "metadataStripped": true,
    "moderationStatus": "unreviewed",
    "createdAt": "2026-01-01T00:00:00.000000Z"
  }
}
```

`url` adalah path relatif terhadap host API; klien menggabungkannya dengan base URL-nya sendiri. Nilai ini bisa langsung dipakai sebagai `imageRef` pada `PATCH /tenants/{id}/menu/items/{itemId}`.

### Validasi

| Pemeriksaan                            | Gagal →                          |
| -------------------------------------- | -------------------------------- |
| Ada part bernama tepat `file`          | 400 `MEDIA_FILE_REQUIRED`        |
| Berkas tidak kosong                    | 400 `MEDIA_EMPTY_FILE`           |
| Ukuran ≤ `MEDIA_MAX_BYTES`             | 413 `MEDIA_FILE_TOO_LARGE`       |
| Tipe deklarasi termasuk allowlist      | 415 `MEDIA_TYPE_NOT_ALLOWED`     |
| Isi berkas dikenali sebagai gambar     | 415 `MEDIA_CONTENT_UNRECOGNISED` |
| Isi berkas cocok dengan tipe deklarasi | 415 `MEDIA_TYPE_MISMATCH`        |

Tipe tidak dipercaya dari klien. `src/modules/media/image-probe.ts` membaca **magic bytes** dan ukuran dari header (PNG IHDR, rantai marker JPEG sampai SOF, chunk WebP VP8/VP8L/VP8X) tanpa decode piksel dan tanpa library gambar. SVG sengaja ditolak: SVG adalah markup yang bisa dieksekusi, bukan sekadar gambar.

Batas ukuran ditegakkan dua kali — oleh parser multipart saat streaming (agar badan kebesaran tidak pernah dibuffer penuh) dan oleh `MediaService` sebelum menulis.

### Metadata kamera dibuang

Sebelum byte ditulis ke disk, `metadata-strip.ts` menghapus metadata yang menempel di berkas:

| Format | Dibuang                                                  | Dipertahankan (sengaja)                 |
| ------ | -------------------------------------------------------- | --------------------------------------- |
| JPEG   | APP1 (EXIF/XMP), APP13, COM                              | APP0 (densitas JFIF), APP2 (profil ICC) |
| PNG    | `tEXt`, `zTXt`, `iTXt`, `eXIf`                           | IHDR/PLTE/IDAT/IEND, `iCCP`             |
| WebP   | chunk `EXIF` dan `XMP` (+ bit flag VP8X-nya dibersihkan) | chunk gambar, bit ICC/alpha pada VP8X   |

Alasannya: foto menu yang diunggah dari ponsel membawa **koordinat GPS, model perangkat dan waktu pengambilan**. Tanpa penghapusan, setiap pembeli yang memuat gambar ikut menerima lokasi pemiliknya. Profil ICC dipertahankan karena itu manajemen warna, bukan identitas — membuangnya mengubah warna yang dirender.

Konsekuensi yang perlu diketahui klien:

- `byteSize`, `checksumSha256` dan `ETag` menggambarkan **byte yang tersimpan**, bukan byte yang diunggah. Ukurannya bisa lebih kecil.
- `metadataStripped` bernilai `true` hanya bila ada yang benar-benar dihapus. Berkas tanpa metadata disimpan apa adanya (checksum sama dengan unggahan).
- Penghapusan hanya menyentuh metadata, **bukan piksel**: chunk data gambar disalin utuh. Berkas hasilnya tetap bisa dibaca `probeImage`.
- Container yang tidak dikenali atau rusak dikembalikan apa adanya, bukan ditebak — kehilangan data lebih buruk daripada metadata tersisa.
- Bila hasil penghapusan tidak lagi terbaca sebagai format yang sama, unggahan **gagal** (500 `MEDIA_METADATA_STRIP_FAILED`) daripada menyimpan berkas yang tidak bisa ditampilkan.

**Belum ada backfill**: berkas yang diunggah sebelum perubahan ini masih menyimpan metadatanya.

### Penyimpanan

Kunci penyimpanan dibuat server: `YYYY/MM/<uuid>.<ext>`. Klien tidak pernah menyumbang bagian path apa pun, sehingga tidak ada jalur untuk keluar dari `MEDIA_ROOT` atau menimpa berkas milik pengguna lain. `MediaService.resolvePath` tetap memeriksa ulang sebagai pertahanan berlapis.

Berkas ditulis ke `<key>.<uuid>.part` lalu di-`rename`, jadi berkas separuh jadi tidak pernah muncul di kunci yang ditunjuk database. Bila `INSERT` gagal, berkas dihapus kembali agar tidak ada orphan.

## `GET /media/{id}`

Mengalirkan byte dengan `Content-Type` sebenarnya. Respons membawa `ETag` dari checksum SHA-256, `Cache-Control: public, max-age=31536000, immutable`, dan `X-Content-Type-Options: nosniff`. Kirim `If-None-Match` untuk mendapat `304`.

Aset yang dihapus, tidak dikenal, atau yang barisnya masih ada tetapi berkasnya hilang dari disk menjawab `404 MEDIA_NOT_FOUND`.

## `DELETE /media/{id}`

Hapus lunak: `deleted_at` diisi, baris tetap ada sebagai tombstone, dan `GET` langsung berhenti melayani. Berkas di disk **tidak** dihapus — pembersihan diserahkan ke operator agar penghapusan tidak pernah menghilangkan bukti secara diam-diam.

Aset milik orang lain menjawab `404`, bukan `403`, supaya endpoint tidak bisa dipakai menebak keberadaan unggahan orang lain.

## Konfigurasi

| Variabel          | Default           | Batas                      |
| ----------------- | ----------------- | -------------------------- |
| `MEDIA_ROOT`      | `./storage/media` | direktori dibuat saat boot |
| `MEDIA_MAX_BYTES` | `5242880` (5 MiB) | 1024 – 20971520            |

`MEDIA_MAX_BYTES` hanya bisa mempersempit; batas atas mutlak 20 MiB juga dikunci oleh CHECK di database.

## Batasan yang perlu diketahui

- **Disk lokal, bukan object storage.** Berkas tidak ikut berpindah saat container dibangun ulang dan tidak dibagi antar-instance. Deployment multi-host memerlukan S3/R2 (atau volume bersama) sebelum modul ini bisa diandalkan.
- **Moderasi gambar belum ada.** `moderationStatus` hanya status baca (`unreviewed`/`clear`/`flagged`) dengan default `unreviewed`; tidak ada endpoint, scanner, maupun permission untuk mengubahnya karena belum ada provider. Nilai `clear` tidak pernah diproduksi sistem ini.
- **Tanpa thumbnail dan tanpa resize.** Klien mengunduh ukuran asli.
- **Metadata dihapus hanya pada unggahan baru.** Aset lama tidak di-backfill.
- **Tidak ada pembersihan otomatis.** Tombstone dan berkasnya bertahan sampai operator membersihkannya.

## Pengujian

| Berkas                     | Cakupan                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `test/media-probe.spec.ts` | pembacaan header PNG/JPEG/WebP, header terpotong, isi bukan gambar, panjang segmen rusak                         |
| `test/media-http.spec.ts`  | kontrak HTTP: auth, `purpose`, part hilang, 413, ETag/304, 404, 204                                              |
| `test/media.spec.ts`       | integrasi PostgreSQL: berkas benar-benar tertulis, dimensi, checksum, hapus lunak, kepemilikan, CHECK constraint |
