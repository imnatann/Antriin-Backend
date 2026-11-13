# Modul Reporting (KAN-70)

Laporan baca-saja: laporan penjualan tenant dan dashboard pantauan kampus. Modul ini **tidak punya tabel sendiri**, tidak menulis baris, tidak memindahkan uang, dan tidak membuat definisi finansial baru.

Batas yang dijaga (REQUIREMENTS §3.8.8): definisi gross/net, fee, pajak, ekspor dan waktu settlement **belum diputuskan**. Karena itu laporan hanya menyajikan **jumlah baris** dan **penjumlahan kolom yang sudah ada**, dikelompokkan per status yang sudah ada. Tidak ada angka "pendapatan", "netto", atau "fee" yang dikarang di sini.

## Endpoint

| Method | Path                                      | Aktor        | Permission                 |
| ------ | ----------------------------------------- | ------------ | -------------------------- |
| GET    | `/api/v1/tenants/:tenantId/reports/sales` | staf tenant  | `tenant.sales.read`        |
| GET    | `/api/v1/campuses/:campusId/dashboard`    | campus admin | `campus.transactions.read` |

Keduanya wajib menerima query `from` dan `to` (ISO 8601) dan memakai jendela **setengah terbuka** `[from, to)`.

## Parameter

- `from` inklusif, `to` eksklusif. Keduanya **wajib**: laporan tidak boleh diam-diam memindai seluruh tabel.
- Rentang maksimum 366 hari (`REPORT_RANGE_TOO_LARGE`).
- `from >= to` ditolak (`REPORT_RANGE_INVALID`), begitu pula tanggal yang tidak bisa di-parse.
- Parameter query lain ditolak oleh `whitelist + forbidNonWhitelisted`.

Kode error: `REPORT_RANGE_REQUIRED`, `REPORT_RANGE_INVALID`, `REPORT_RANGE_TOO_LARGE`.

## Bentuk respons

Laporan penjualan tenant (`{ data }`):

```json
{
  "tenantId": "…",
  "currency": "IDR",
  "from": "2026-01-01T00:00:00.000Z",
  "to": "2026-02-01T00:00:00.000Z",
  "orders": [{ "status": "completed", "count": 2, "totalMinor": "80000" }],
  "refunds": [{ "status": "succeeded", "count": 1, "totalMinor": "50000" }]
}
```

Dashboard kampus menambahkan `tenants`, `payouts` dan `cases`:

- `tenants`: `{ status, count }` seluruh tenant kampus (tidak difilter rentang, karena status tenant adalah keadaan sekarang).
- `orders`, `refunds`, `payouts`: `{ status, count, totalMinor }` difilter `created_at` dalam rentang.
- `cases`: `{ status, count }` difilter `created_at` dalam rentang.

Hanya grup yang punya baris yang dikembalikan; status tanpa baris tidak muncul sebagai nol. Klien yang butuh deret lengkap mengisi nol sendiri.

## Cakupan dan sumber data

- `totalMinor` adalah penjumlahan `orders.total_minor` / `refunds.amount_minor` / `payouts.amount_minor` — bukan pendapatan, bukan saldo.
- `orders` dan `payouts` **tidak** menyimpan `campus_id`; cakupan kampus dihitung lewat join ke `tenants`. REQUIREMENTS §7.2 menyebut `orders.campus_id` sebagai kolom minimum, sedangkan schema yang sudah diterima menyelesaikannya lewat tenant — perbedaan ini dicatat, bukan diubah di sini.
- `refunds` dan `cases` sudah membawa `campus_id` sendiri sehingga difilter langsung.
- Antrean sinyal risiko / tinjauan AI **tidak** ada di dashboard karena slice `risk` masih scaffold.

## Kenapa tidak ada tabel laporan

Laporan dihitung saat dibaca dari tabel transaksi. Requirement §7.5 meminta beban laporan dipisahkan dari transaksi kritis lewat read replica/projection; untuk volume pilot ini query agregat terindeks cukup, dan penambahan projection baru dicatat sebagai pekerjaan berikutnya bersama ekspor laporan dan penjadwalan.
