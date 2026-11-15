# Undangan Staf Tenant

Menambahkan anggota staf tanpa mencabut kontrol pemilik atas siapa yang masuk dan dengan izin apa.

## Endpoint

| Method | Path                                                  | Permission                  |
| ------ | ----------------------------------------------------- | --------------------------- |
| POST   | `/api/v1/tenants/{tenantId}/staff/invites`            | `tenant.staff.manage`       |
| GET    | `/api/v1/tenants/{tenantId}/staff/invites`            | `tenant.staff.manage`       |
| DELETE | `/api/v1/tenants/{tenantId}/staff/invites/{inviteId}` | `tenant.staff.manage`       |
| POST   | `/api/v1/tenant-invites/{token}/accept`               | sesi pengguna yang diundang |

## Membuat undangan

```json
{ "userId": "…", "role": "kitchen", "permissions": ["tenant.orders.read"] }
```

- Role harus `kitchen` atau `pickup`. Pemilik baru dibuat lewat jalur provisioning, bukan undangan.
- Setiap permission divalidasi terhadap katalog `TENANT_PERMISSIONS` **dan** allowlist role yang sama yang ditegakkan `AccessService`.
- Pengundang tidak dapat memberikan permission yang tidak ia miliki sendiri (403 `INVITE_PERMISSION_EXCEEDS_ACTOR`), tidak dapat mengundang dirinya (403 `INVITE_SELF_FORBIDDEN`), dan tidak dapat mengundang pengguna nonaktif, pengguna yang sudah menjadi staf, atau membuat undangan kedua yang masih terbuka.
- Token = 32 byte acak (base64url). Database hanya menyimpan **sha256**, sama seperti sesi dan kode pickup; token mentah dikembalikan **sekali** pada respons POST.

## Menerima

`POST /tenant-invites/{token}/accept` memerlukan sesi. Baris dikunci, role/permission disimpan ulang dari database (bukan dari klien), membership dibuat atau dipakai kembali, `accepted_at` distempel, lalu `access_audit_events` dan `audit_events` ditulis.

Kode penolakan dibedakan agar klien dapat menampilkan sebabnya: `INVITE_NOT_FOUND` (404), `INVITE_USER_MISMATCH` (403), `INVITE_ALREADY_ACCEPTED` / `INVITE_REVOKED` / `INVITE_EXPIRED` / `INVITE_TENANT_UNAVAILABLE` / `INVITE_MEMBERSHIP_CONFLICT` (409).

## Mencabut

`DELETE` bersifat idempoten dan menolak mencabut undangan yang sudah diterima (409) — anggota yang sudah masuk harus dicabut lewat jalur akses, bukan lewat undangan.

## Batasan

- **Tidak ada pengiriman email.** Token diserahkan pemilik sendiri. Tanpa provider email, undangan tidak bisa sampai otomatis.
- Daftar undangan tidak pernah memproyeksikan token maupun hash-nya.
- Belum ada undangan berdasarkan alamat email; undangan menunjuk `userId` yang sudah ada.
