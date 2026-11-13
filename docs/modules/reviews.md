# Modul Reviews (KAN-70)

Ulasan pembeli atas order yang sudah selesai, balasan tenant, pelaporan, dan moderasi kampus. Skema ada di migrasi `0010` (`src/database/schema/reviews.ts`).

Aturan yang dipegang ([AGENTS.md](../../AGENTS.md), REQUIREMENTS §3.9):

- ulasan hanya untuk order **completed** milik pemanggil, dan pembeli harus punya **email kampus terverifikasi** untuk kampus tenant tersebut;
- **satu ulasan per order**, termasuk ulasan yang sudah dihapus pembeli (soft delete) — order tidak bisa diulas dua kali;
- tenant hanya bisa **membaca dan membalas**, tidak pernah mengedit atau menghapus ulasan pembeli;
- rating rendah **bukan** pelanggaran; menyembunyikan ulasan adalah keputusan manusia dengan alasan, jejak append-only, audit, dan notifikasi;
- ulasan publik **tidak** memuat identitas pembeli maupun id order.

## Endpoint

| Method | Path                                                               | Aktor               | Permission / syarat                                                  |
| ------ | ------------------------------------------------------------------ | ------------------- | -------------------------------------------------------------------- |
| POST   | `/api/v1/orders/:orderId/reviews`                                  | buyer pemilik       | order `completed` + `campus_email_verifications` untuk kampus tenant |
| GET    | `/api/v1/me/reviews`                                               | buyer               | hanya ulasan miliknya (termasuk yang disembunyikan moderator)        |
| GET    | `/api/v1/tenants/:tenantId/reviews`                                | publik              | hanya `visible`, tanpa identitas pembeli                             |
| GET    | `/api/v1/tenants/:tenantId/reviews/manage`                         | staf tenant         | `tenant.reviews.reply`                                               |
| POST   | `/api/v1/tenants/:tenantId/reviews/:reviewId/replies`              | staf tenant         | `tenant.reviews.reply` + ulasan milik tenant itu                     |
| PATCH  | `/api/v1/reviews/:reviewId`                                        | buyer pemilik       | ulasan miliknya dan belum dihapus                                    |
| DELETE | `/api/v1/reviews/:reviewId`                                        | buyer pemilik       | soft delete, idempoten                                               |
| POST   | `/api/v1/reviews/:reviewId/reports`                                | user terautentikasi | satu laporan per (ulasan, pelapor)                                   |
| GET    | `/api/v1/campuses/:campusId/moderation/reviews`                    | campus admin        | `campus.reviews.moderate`                                            |
| POST   | `/api/v1/campuses/:campusId/moderation/reviews/:reviewId/decision` | campus admin        | `campus.reviews.moderate`                                            |

Semua route memakai envelope `{ data }` / `{ data, meta }`. Pembuatan ulasan, balasan, laporan dan keputusan menjawab **201**; `PATCH` dan `DELETE` menjawab **200** (delete bukan `204` karena respons mengembalikan ulasan yang sudah ditandai).

Tidak ada permission baru: slice ini memakai `tenant.reviews.reply` dan `campus.reviews.moderate` yang sudah ada di `AccessService`.

## Alur

```text
order completed
  -> buyer POST /orders/:id/reviews            status 'visible'
     (audit tidak ditulis: bukan aksi keuangan/akses/keputusan pengelola)

buyer  -> PATCH /reviews/:id                   rating/body berubah; ulasan 'hidden' menolak 409
buyer  -> DELETE /reviews/:id                  deleted_at diisi; UNIQUE(order_id) tetap menahan ulasan kedua

user   -> POST /reviews/:id/reports            review_reports 'open' + status 'reported'
                                                + outbox 'review.reported' ke pemegang campus.reviews.moderate

tenant -> POST /tenants/:tid/reviews/:id/replies   upsert SATU balasan per ulasan

campus -> POST /campuses/:cid/moderation/reviews/:id/decision { action: keep|hide, reason }
            1. review_moderation_actions (append-only, alasan wajib)
            2. reviews.status -> 'visible' | 'hidden' (+ hidden_at, hidden_by_user_id)
            3. semua review_reports 'open' -> 'resolved'
            4. audit 'campus.reviews.moderated'
            5. outbox 'review.moderated' ke pembeli
```

## Invariant yang dijaga database

- `reviews_order_unique` (unique index): satu ulasan per order, termasuk yang sudah di-soft-delete.
- `reviews_tenant_order_fk` (FK komposit): ulasan harus menunjuk order **tenant yang sama**.
- `reviews_rating_check`: `rating between 1 and 5`. `reviews_body_check`: body tidak boleh kosong.
- `reviews_hidden_check`: `status = 'hidden'` **iff** `hidden_at` dan `hidden_by_user_id` terisi — status tidak bisa "disembunyikan" tanpa jejak siapa dan kapan.
- `review_replies_review_unique`: satu balasan per ulasan; `review_replies_tenant_review_fk` menolak balasan lintas tenant.
- `review_reports_reporter_unique`: satu laporan per (ulasan, pelapor).
- `review_reports_resolved_check`: `resolved_at` hanya terisi saat status `resolved`.
- `review_moderation_actions_action_check`: aksi hanya `keep` / `hide`; alasan wajib tidak kosong.

## Catatan perilaku

- Timestamp respons adalah string mikrodetik UTC dari PostgreSQL (D7), bukan hasil serialisasi `Date`.
- `GET /tenants/:tenantId/reviews` adalah satu-satunya route publik; ia memakai proyeksi `PublicReviewView` sehingga `buyerId` dan `orderId` tidak pernah keluar.
- Ulasan yang dihapus pembeli hilang dari `/me/reviews`, daftar tenant, daftar publik, dan antrean moderasi, tetapi barisnya tetap ada untuk audit dan menahan ulasan kedua.
- Ulasan yang disembunyikan moderator tetap bisa dihapus pembeli; pembeli tidak bisa mengeditnya (409 `REVIEW_HIDDEN`) supaya hasil moderasi tidak bisa diakali.
- Moderator bisa membalik keputusan (`hide` lalu `keep`); setiap keputusan menambah satu baris jejak, tidak pernah menimpa.
