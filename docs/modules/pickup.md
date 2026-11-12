# Modul Pickup (KAN-70)

Slice kredensial pengambilan dan serah terima satu kali. Kode milik slice ini; perubahan status order tetap melalui kontrak `OrdersService` (D16.6) — slice pickup tidak pernah menulis tabel `orders` langsung.

## Endpoint

| Method | Path                                                                 | Aktor         | Permission               | Efek                                                                               |
| ------ | -------------------------------------------------------------------- | ------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| POST   | `/v1/tenants/:tenantId/orders/:orderId/pickup-credential`            | staf tenant   | `tenant.orders.handover` | Terbitkan/rotasi kode; plaintext hanya dikembalikan sekali di respons ini          |
| POST   | `/v1/tenants/:tenantId/orders/:orderId/pickup-credential/revocation` | staf tenant   | `tenant.orders.handover` | Cabut kredensial aktif; `reason` wajib                                             |
| POST   | `/v1/tenants/:tenantId/pickup/verification`                          | staf tenant   | `tenant.orders.handover` | Verifikasi kode tanpa efek samping                                                 |
| POST   | `/v1/tenants/:tenantId/pickup/handovers`                             | staf tenant   | `tenant.orders.handover` | Serah terima: order `completed`, reservasi `consumed`, kredensial `consumed`       |
| GET    | `/v1/orders/:orderId/pickup-credential`                              | buyer pemilik | sesi buyer               | Baca ulang kode aktif miliknya (didekripsi server-side, `Cache-Control: no-store`) |

Semua rute memakai `AuthGuard`. Dua rute terakhir yang menerima kode dari pengguna memakai `PickupRateLimitGuard` (Redis sliding window, namespace `antriin:pickup:rate:code`, 30 percobaan / 600 detik per klien) dan **fail-closed** bila Redis tidak tersedia.

## Aturan bisnis

1. **Penerbitan hanya untuk order `ready_for_pickup`.** Status lain -> `409 PICKUP_NOT_READY`. Kode diterbitkan oleh staf berizin; buyer tidak dapat menerbitkan sendiri.
2. **Kode tidak pernah disimpan sebagai plaintext.** Lookup memakai `code_hash` = HMAC-SHA256 dengan `AUTH_SECRET` (64 hex, unik di DB). `code_ciphertext` (AES-256-GCM dengan `AUTH_ENCRYPTION_KEY`) hanya agar pemilik dapat menampilkan ulang kode; tidak pernah dicetak ke log.
3. **Masa berlaku** dari `PICKUP_CREDENTIAL_TTL_SECONDS` (config, default 7200, batas 300..86400). Constraint DB `pickup_credentials_expires_at_check` mewajibkan `expires_at > created_at`. Kode kedaluwarsa -> `410 PICKUP_CREDENTIAL_EXPIRED` pada verifikasi dan handover.
4. **Satu kredensial aktif per order** (partial unique `revoked_at IS NULL`). Penerbitan ulang = rotasi: kredensial lama dicabut dan yang baru dibuat dalam transaksi yang sama, sehingga kode lama langsung mati.
5. **Handover sekali.** Handover memanggil `OrdersService.getOrderForHandover` + `markHandedOver` dalam transaksi yang sama, lalu menandai kredensial `consumed` (`consumed_at`). Constraint DB `pickup_credentials_consume_revoke_check` melarang `consumed_at` dan `revoked_at` terisi bersamaan, dan `order_handovers` memiliki composite FK `(order_id, credential_id) -> pickup_credentials(order_id, id)` sehingga kredensial order lain tidak dapat dipakai.
6. **Replay handover = 409 konsisten** (`PICKUP_CREDENTIAL_CONSUMED`), bukan 200 diam-diam: staf harus tahu kode sudah dipakai. Tidak ada efek kedua (order, reservasi, handover row tidak berubah).
7. **Kode milik tenant lain -> 404** pada verifikasi dan handover (eksistensi tidak bocor). Buyer lain -> 404 pada pembacaan kode.
8. **Pencabutan** memerlukan `reason` (1..500) dan menulis audit `tenant.pickup.credential_revoked` + `order_events pickup_credential.revoked`. Kredensial yang sudah `consumed` tidak dapat dicabut.
9. **Audit** ditulis dalam transaksi yang sama untuk penerbitan (`tenant.pickup.credential_issued`) dan pencabutan, dengan actor dari sesi, target kredensial/order, serta alasan.

## Kode error kontrak

`PICKUP_NOT_READY`, `PICKUP_CODE_INVALID`, `PICKUP_CREDENTIAL_NOT_FOUND`, `PICKUP_CREDENTIAL_REVOKED`, `PICKUP_CREDENTIAL_CONSUMED`, `PICKUP_CREDENTIAL_EXPIRED`, `PICKUP_HANDOVER_CONFLICT`, `pickup_code_generation_failed`, `pickup_not_configured`, `pickup_code_unavailable`, `pickup_rate_limited`, `pickup_rate_limit_unavailable`.

## Keputusan dan batasan

- **Plaintext hanya di respons penerbitan**; pemilik boleh membaca ulang lewat `GET /v1/orders/:orderId/pickup-credential` karena kode adalah tiket miliknya sendiri. Staf tidak pernah dapat membaca ulang kode, hanya memverifikasi.
- **Tanpa kolom penghitung percobaan di DB**: brute force ditahan di lapisan Redis (keputusan D12 butir 10). Bila Redis mati, verifikasi menolak (fail-closed), bukan meloloskan.
- **Rotasi kunci enkripsi** belum ada jalur otomatis: bila `AUTH_ENCRYPTION_KEY` diganti, ciphertext lama tidak dapat didekripsi (`pickup_code_unavailable`) dan solusinya adalah rotasi kredensial (terbitkan kode baru). Backup/rotasi kunci = pekerjaan operasional, bukan wave ini.
- **Notifikasi ke buyer** saat kode terbit hanya lewat outbox bila slice notifikasi menambahkan tipe event pickup; saat ini tidak ada event outbox baru (batasan yang disengaja).
- Tidak ada endpoint publik untuk menebak kode; tidak ada endpoint yang mengembalikan kode staf/buyer lain.

## Pengujian

`test/pickup.spec.ts` — 11 test terhadap PostgreSQL nyata: penerbitan hanya untuk order siap + hash-only storage + event + audit; pembacaan ulang oleh pemilik dan 404 untuk buyer lain; verifikasi ternormalisasi tanpa efek samping; handover tepat sekali (order completed, reservasi consumed, baris handover); replay 409 tanpa efek kedua; handover sebelum siap ditolak dan seluruh efek di-rollback; kode kedaluwarsa 410 pada verifikasi dan handover; rotasi mematikan kode lama; pencabutan wajib alasan + audit + event + kode tidak berlaku; kode tenant lain 404; constraint DB menolak consumed+revoked bersamaan, handover lintas order, dan dua kredensial aktif.

Cara menjalankan:

```sh
export PATH=/Users/macbook/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH
npx tsc -p tsconfig.test.json --outDir .test-dist-pickup
TEST_DATABASE_URL=postgresql://antriin_swarm:swarm_local_only@127.0.0.1:5544/antriin_pickup \
  REDIS_HOST=127.0.0.1 REDIS_PORT=6381 TEST_REDIS_PORT=6381 \
  CORS_ORIGINS=http://localhost:3001 NODE_ENV=test \
  node --test .test-dist-pickup/test/pickup.spec.js
```
