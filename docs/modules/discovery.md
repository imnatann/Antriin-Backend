# Modul Penemuan Publik (pencarian dan rekomendasi)

Dua endpoint publik tanpa token untuk beranda pembeli. Modul ini **read-only**: tidak punya tabel sendiri, tidak menulis baris, tidak memindahkan uang, dan tidak memerlukan `AccessService` karena hanya membaca data yang memang publik (kampus aktif, tenant tidak diarsipkan, menu `active`, ulasan `visible`).

## Endpoint

| Method | Path                      | Auth |
| ------ | ------------------------- | ---- |
| GET    | `/api/v1/search`          | —    |
| GET    | `/api/v1/recommendations` | —    |

## `GET /search`

| Query      | Wajib | Batas             |
| ---------- | ----- | ----------------- |
| `q`        | ya    | 1–100 karakter    |
| `campusId` | tidak | UUID kampus aktif |
| `limit`    | tidak | 1–50, default 20  |

```json
{
  "data": {
    "tenants": [
      {
        "id": "…",
        "name": "Kantin Sehat",
        "campusId": "…",
        "campusName": "Kampus Demo",
        "location": "Gedung A Lt. 1",
        "status": "open",
        "matchedOn": "name"
      }
    ],
    "items": [
      {
        "id": "…",
        "tenantId": "…",
        "tenantName": "Kantin Sehat",
        "tenantStatus": "open",
        "categoryId": "…",
        "categoryName": "Makanan",
        "name": "Nasi Ayam",
        "description": "…",
        "priceMinor": "15000",
        "currency": "IDR",
        "status": "active"
      }
    ]
  },
  "meta": { "query": "ayam", "limit": 20 }
}
```

Aturan pencocokan:

- Case-insensitive `ILIKE` pada nama dan lokasi tenant, serta nama dan deskripsi item.
- `%` dan `_` di `q` di-_escape_ sehingga tidak menjadi wildcard (pola yang sama dipakai `campuses.service.ts`).
- Hanya kampus `active` dan tenant selain `archived` yang muncul.
- Item `sold_out` **tetap ditampilkan** dengan `status: "sold_out"` — itemnya ada, hanya sedang tidak tersedia; klien yang menandainya. Item `archived` tidak muncul.
- `q` kosong atau hanya spasi dijawab **400** `SEARCH_QUERY_REQUIRED`.

## `GET /recommendations`

| Query            | Wajib | Batas             |
| ---------------- | ----- | ----------------- |
| `campusId`       | tidak | UUID kampus aktif |
| `tenantId`       | tidak | UUID tenant       |
| `budgetMaxMinor` | tidak | integer ≥ 0 (IDR) |
| `limit`          | tidak | 1–50, default 10  |

```json
{
  "data": [
    {
      "menuItemId": "…",
      "name": "Nasi Ayam",
      "description": "…",
      "priceMinor": "15000",
      "currency": "IDR",
      "tenantId": "…",
      "tenantName": "Kantin Sehat",
      "tenantStatus": "open",
      "rating": { "average": "4.50", "count": 12 },
      "nextPickupStartsAt": "2026-11-14T03:00:00.000000Z",
      "score": "0.87"
    }
  ],
  "meta": { "limit": 10, "criteria": { "…": "…" } }
}
```

### Rating tidak dikarang

`rating.average` dihitung **hanya** dari `reviews` dengan `status = 'visible'` dan `deleted_at IS NULL`, sebagai `numeric` dua desimal yang dikirim sebagai string. Bila belum ada ulasan sama sekali, `rating.average` bernilai `null` dan `count` bernilai `0` — klien **wajib** menampilkan "belum ada ulasan" alih-alih bintang nol. REQUIREMENTS §3.2.4 melarang mengarang rating.

### Kriteria skor

`score` adalah heuristik yang ditulis terbuka di `meta.criteria` supaya dapat ditelusuri dan diperdebatkan, bukan model tersembunyi:

- Rating dinormalisasi ke 0–1 dengan bobot 0.6; item tanpa ulasan memakai rating netral 0.5 dan ditandai di `meta.criteria`.
- Kebaruan slot pickup terdekat dengan bobot 0.4.
- Urutan akhir deterministik (skor lalu id) agar dua permintaan identik menghasilkan urutan sama.

### Kandidat

Hanya item `active` dari tenant `open` di kampus `active` yang **masih punya slot pickup terbuka dan akan datang** (`pickup_slots.status = 'open'`, `reserved_count < capacity`, `starts_at > now()`). `nextPickupStartsAt` adalah slot terdekat. `budgetMaxMinor` menyaring `price_minor <= budget`.

## Yang sengaja belum ada

- Personalisasi per pembeli: belum ada sinyal preferensi yang tersimpan, jadi rekomendasi bersifat katalog-wide.
- Pencarian berbasis teks penuh/trigram; `ILIKE` cukup untuk volume pilot.
- Halaman hasil berhalaman: hasil dibatasi `limit` per kategori.
