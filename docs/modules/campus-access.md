# Modul Akses Kampus dan Domain Email

Dua hal berbeda ditangani di modul `campuses`: **membaca** siapa saja pengelola sebuah kampus, dan **mengelola domain email kampus** yang boleh dipakai untuk verifikasi pembeli.

## Batas yang dijaga

[docs/ACCESS.md](../ACCESS.md) menyatakan tegas: _tidak ada endpoint publik yang memberi akses kampus atau permission luas_. Karena itu modul ini **tidak** menyediakan grant/revoke membership kampus. Provisioning pengelola kampus tetap lewat `CampusProvisioningService` (jalur terkontrol: script/worker atau aktor yang sudah memegang `campus.access.manage`).

| Kebutuhan produk (REQUIREMENTS §3.10.2) | Cara dipenuhi                                                     |
| --------------------------------------- | ----------------------------------------------------------------- |
| "mengelola staf/akses"                  | `GET /campuses/:id/access` (baca) + jalur provisioning terkontrol |
| "domain email kampus yang diizinkan"    | CRUD `/campuses/:id/email-domains`                                |

## Endpoint

| Method | Path                                                            | Permission             |
| ------ | --------------------------------------------------------------- | ---------------------- |
| GET    | `/api/v1/campuses/:campusId/access`                             | `campus.access.manage` |
| GET    | `/api/v1/campuses/:campusId/email-domains`                      | `campus.access.manage` |
| POST   | `/api/v1/campuses/:campusId/email-domains`                      | `campus.access.manage` |
| POST   | `/api/v1/campuses/:campusId/email-domains/:domainId/verify`     | `campus.access.manage` |
| POST   | `/api/v1/campuses/:campusId/email-domains/:domainId/dns-verify` | `campus.access.manage` |
| PATCH  | `/api/v1/campuses/:campusId/email-domains/:domainId`            | `campus.access.manage` |
| DELETE | `/api/v1/campuses/:campusId/email-domains/:domainId`            | `campus.access.manage` |

## Daftar pengelola kampus

```json
{ "data": [{ "membershipId": "…", "userId": "…", "displayName": "Admin Kampus",
              "permissions": ["campus.transactions.read"], "status": "active",
              "createdAt": "…", "updatedAt": "…" }] }
}
```

Hanya anggota `active` pada kampus itu, diurutkan menurut nama tampilan. Endpoint ini hanya membaca; tidak ada cara menambah atau mencabut pengelola dari HTTP.

## Domain email kampus

Domain adalah gerbang verifikasi email kampus: `AuthService` hanya menerima domain dengan `active = true` **dan** `verified_at IS NOT NULL`.

### Membuat

```json
{ "domain": "Student.AC.id", "reason": "Domain resmi kampus" }
}
```

- `domain` di-_trim_ dan di-_lowercase_ sebelum disimpan; constraint database juga menolak nilai non-lowercase.
- Validasi hostname: huruf/angka/titik/tanda hubung, minimal satu titik, maksimum 253 karakter.
- Duplikat global (unique index pada `domain`) dijawab **409** `EMAIL_DOMAIN_TAKEN` — domain hanya boleh dimiliki satu kampus.
- Baris baru dibuat `active = true`, `verified_at = NULL`, sehingga **belum** membuka verifikasi email sampai diverifikasi.

### Dua verifikasi yang berbeda

| Kolom           | Artinya                                            | Mengaktifkan domain untuk auth?                        |
| --------------- | -------------------------------------------------- | ------------------------------------------------------ |
| `verifiedAt`    | Pengelola menyatakan domain milik kampus           | **Ya** — satu-satunya saklar yang dibaca `AuthService` |
| `dnsVerifiedAt` | TXT record membuktikan kampus mengendalikan domain | **Tidak**                                              |

Pemisahan ini disengaja. `verifiedAt` adalah attestation: ia tidak membuktikan kepemilikan, hanya bahwa pengelola menyetujuinya. `dnsVerifiedAt` adalah bukti nyata, tetapi membiarkannya langsung menyalakan domain berarti gangguan DNS sesaat bisa mengubah siapa yang boleh menulis ulasan. Domain yang sudah terbukti lewat DNS tetap diaktifkan pengelola lewat `POST .../verify`.

### Verifikasi (attestasi pengelola)

```json
{ "reason": "Kepemilikan domain dikonfirmasi lewat surat resmi kampus" }
```

Endpoint ini mencatat bahwa pengelola berizin sudah memverifikasi kepemilikan domain di luar sistem; itulah sebabnya `reason` wajib dan setiap verifikasi menulis `audit_events`. Memanggil ulang pada domain yang sudah terverifikasi bersifat idempoten: `verified_at` tidak berubah.

### Verifikasi DNS (`POST .../dns-verify`)

Domain pendaftaran menyertakan `dnsToken` (32 karakter hex acak, dibuat server — klien tidak pernah memilihnya) pada respons `GET`/`POST`. Kampus menerbitkan:

```
_antriin-challenge.<domain>   TXT   "antriin-verify=<dnsToken>"
```

Lalu memanggil `POST .../dns-verify` dengan `{ reason }`.

| Hasil                                | Respons                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| TXT cocok                            | 200, `dnsVerifiedAt` terisi, audit `campus.email_domain_dns_verified`                  |
| Record tidak ada / tidak cocok       | 409 `EMAIL_DOMAIN_DNS_MISMATCH` + `recordName` + `expectedValue`, `dnsLastError` diisi |
| Lookup gagal (timeout/resolver mati) | 503 `EMAIL_DOMAIN_DNS_UNAVAILABLE`; server tidak berpura-pura "tidak cocok"            |

Lookup memakai TXT sungguhan (`node:dns/promises`) dengan batas waktu 5 detik, dan berada di balik port `DnsResolver` supaya bisa diuji tanpa bergantung pada isi zona sungguhan. Nilai dianggap cocok hanya bila **sama persis** setelah chunk TXT digabung — pencocokan substring tidak dipakai, agar record lain tidak bisa dipakai menebak.

### Menonaktifkan dan menghapus

- `PATCH { active: false, reason }` langsung menghentikan verifikasi email baru pada domain itu tanpa menghapus riwayat verifikasi pengguna yang sudah ada.
- `DELETE` menghapus baris (domain bukan data transaksi). Audit tetap menyimpan domain dan alasannya.

Semua mutasi menulis `audit_events` dengan aksi `campus.email_domain_created`, `_verified`, `_updated`, atau `_deleted`, `targetType = 'email_domain'`.

## Yang sengaja belum ada

- Memberi/mencabut akses pengelola kampus lewat HTTP (dilarang `docs/ACCESS.md`).
- Verifikasi ulang DNS berkala: `dnsVerifiedAt` tidak pernah dicabut otomatis bila TXT record kemudian dihapus.
- Pengecekan MX/SPF/DKIM, atau verifikasi lewat email ke `admin@`.
- Daftar domain yang pernah terdaftar untuk kampus lain: duplikat dijawab 409 tanpa menyebutkan pemiliknya, supaya tidak membocorkan kampus lain.
