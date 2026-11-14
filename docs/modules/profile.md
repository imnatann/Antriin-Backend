# Modul Profil (`/me`)

Modul `users` menyediakan identitas milik sesi yang sedang aktif. Sebelum modul ini ada, aplikasi hanya mengetahui `user.id` dan `displayName` dari respons verifikasi OTP — tidak cukup untuk memutuskan layar mana yang dirender untuk seorang staf tenant atau pengelola kampus.

Semua endpoint memakai `AuthGuard` dan mengambil aktor dari `@CurrentUser()`. Tidak ada endpoint yang menerima id user dari klien: `DELETE /me/devices/:deviceId` memeriksa kepemilikan lewat `user_id` di klausa query, sehingga perangkat milik orang lain dijawab **404**, bukan 403.

## Endpoint

| Method | Path                                  | Keterangan                                       |
| ------ | ------------------------------------- | ------------------------------------------------ |
| GET    | `/api/v1/me`                          | Profil lengkap + membership + permission efektif |
| PATCH  | `/api/v1/me`                          | Ubah nama tampilan                               |
| GET    | `/api/v1/me/notification-preferences` | Preferensi notifikasi per akun                   |
| PATCH  | `/api/v1/me/notification-preferences` | Ubah sebagian preferensi                         |
| GET    | `/api/v1/me/devices`                  | Perangkat yang terdaftar                         |
| POST   | `/api/v1/me/devices`                  | Daftarkan perangkat (201)                        |
| DELETE | `/api/v1/me/devices/:deviceId`        | Cabut perangkat (204)                            |

## `GET /me`

```json
{
  "data": {
    "id": "…",
    "displayName": "Budi",
    "status": "active",
    "createdAt": "2026-01-05T10:00:00.000000Z",
    "updatedAt": "2026-01-05T10:00:00.000000Z",
    "phone": { "masked": "+62812****0001", "verified": true },
    "campusEmail": {
      "verified": true,
      "campusId": "…",
      "campusName": "Kampus Demo"
    },
    "wallet": { "currency": "IDR", "availableMinor": "200000" },
    "tenants": [
      {
        "tenantId": "…",
        "tenantName": "Kantin Demo",
        "tenantStatus": "open",
        "campusId": "…",
        "campusName": "Kampus Demo",
        "role": "owner",
        "permissions": ["tenant.orders.read", "…"]
      }
    ],
    "campuses": [
      {
        "campusId": "…",
        "campusName": "Kampus Demo",
        "permissions": ["campus.transactions.read"]
      }
    ]
  }
}
```

### Kenapa field ini yang dipakai untuk merender UI

`tenants[].permissions` dan `campuses[].permissions` adalah permission **efektif**, bukan grant mentah:

- `role: "owner"` → seluruh `TENANT_PERMISSIONS`, karena `AccessService.requireTenant` memang memberi owner seluruh izin tenant.
- Staf → daftar `permissions` yang tersimpan pada `tenant_memberships`. Daftar itu sudah tunduk pada allowlist role karena `AccessService.grantTenantMembership` hanya menerima permission di dalam allowlist `kitchen`/`pickup`; `requireTenant` tetap memeriksa ulang irisan allowlist **dan** grant pada setiap request sebagai pertahanan berlapis.
- `campuses[].permissions` → permission kampus yang tersimpan pada `campus_memberships`, sama dengan yang diperiksa `requireCampus`.

Praktisnya UI dan server memakai angka yang sama untuk memutuskan aksi mana yang boleh tampil. Server tetap otoritas akhir: respons `403` selalu mungkin terjadi bila grant berubah di antara dua request.

`tenantStatus` disertakan karena tenant `closed`, `paused`, atau `archived` membuat aksi operasional ditolak server; UI perlu tahu sebelum menampilkan tombol.

### Data sensitif

- **Nomor telepon tidak pernah dikembalikan utuh.** `phone.masked` memakai `users.phone_e164` dengan hanya empat digit terakhir yang terlihat. Modul ini **tidak mendekripsi** `auth_identities.destination_ciphertext`; ciphertext itu hanya dibuka oleh alur OTP.
- `campusEmail` hanya menyebut status verifikasi dan kampusnya, bukan alamat email.
- `wallet.availableMinor` dibaca lewat `WalletService.getBalance` sehingga saldo tetap berasal dari proyeksi ledger, bukan perhitungan ad-hoc.

## `PATCH /me`

```json
{ "displayName": "Budi Santoso" }
}
```

Hanya `displayName` (1–200 karakter, tidak boleh kosong setelah trim) yang dapat diubah. Nomor telepon dan email tidak dapat diubah di sini karena keduanya butuh verifikasi ulang (REQUIREMENTS §3.1.5). Respons berisi profil lengkap yang sudah diperbarui.

## Preferensi notifikasi

```json
{ "orderUpdates": true, "reviewReplies": false, "caseUpdates": true, "pushEnabled": false, "updatedAt": "…" }
}
```

- Baris `notification_preferences` dibuat malas: `GET` **tidak pernah** menulis baris. Bila belum ada baris, respons memakai default (`orderUpdates`, `reviewReplies`, `caseUpdates` = `true`; `pushEnabled` = `false`), sehingga pengguna yang tidak pernah membuka layar ini tetap menerima notifikasi yang memang sudah dikirim produk.
- `PATCH` memakai `INSERT … ON CONFLICT (user_id) DO UPDATE … RETURNING` dan menyetel `updated_at` secara eksplisit (tidak ada trigger). Field yang tidak dikirim tidak berubah.
- Preferensi disimpan di server agar perangkat kedua mewarisi pilihan yang sama. REQUIREMENTS §3.1.5 menyebut preferensi notifikasi perangkat sebagai kontrol klien; menyimpannya di server tidak mengubah perilaku pengiriman karena belum ada kanal eksternal yang aktif.

## Perangkat

```json
{ "platform": "ios", "token": "<push token dari APNs/FCM>", "label": "iPhone Budi" }
}
```

- **Token mentah tidak disimpan.** Server menyimpan `sha256(token)` hex di `user_devices.token_hash`; respons tidak pernah memuat token maupun hash-nya.
- Mendaftarkan token yang sudah terdaftar untuk user yang sama bersifat idempoten: `last_seen_at`, `platform`, dan `label` diperbarui, `revoked_at` dikosongkan kembali, dan baris yang sama dikembalikan.
- Token yang sudah dimiliki user lain dijawab **409** `DEVICE_TOKEN_CONFLICT` — jangan menimpa perangkat pengguna lain.
- `DELETE` bersifat _soft_: `revoked_at` diisi. Baris dipertahankan agar riwayat perangkat tetap dapat diaudit.
- Belum ada provider push yang membaca tabel ini. `POST /me/devices` hanya mencatat perangkat yang **diinginkan** klien.

## Yang sengaja belum ada

- Mengubah nomor telepon atau email (butuh alur verifikasi ulang).
- Menghapus akun. Data transaksi/audit wajib dipertahankan (REQUIREMENTS §7.6), jadi penghapusan akun adalah pseudonimisasi yang butuh keputusan produk.
- Pengiriman push/email/WhatsApp.
