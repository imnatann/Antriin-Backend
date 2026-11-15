# Aliran Peristiwa (SSE)

Satu endpoint untuk memberi tahu klien bahwa ada notifikasi baru, tanpa polling berulang.

## `GET /api/v1/events/stream`

| Aspek               | Nilai                                                              |
| ------------------- | ------------------------------------------------------------------ |
| Auth                | bearer, lewat header `Authorization` **atau** query `access_token` |
| Content type        | `text/event-stream`                                                |
| Sumber data         | tabel `notifications` (bukan bus dalam proses)                     |
| Batas waktu koneksi | `EVENTS_STREAM_MAX_SECONDS`, default 900 detik                     |

### Kenapa query token diizinkan

`EventSource` di browser tidak bisa memasang header, jadi token lewat query diterima — tetapi **header tetap diutamakan**: token di URL ikut tercatat di log proxy dan access log. Keduanya melewati jalur autentikasi yang sama (`AuthService.authenticate`); `AuthGuard` sendiri tidak dilonggarkan.

### Event yang dikirim

| Event          | Kapan                                      | Isi                                                                           |
| -------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| `ready`        | koneksi dibuka                             | `stream`, `userId`, interval poll/heartbeat, batas waktu, status resume       |
| `notification` | baris baru untuk pemanggil                 | `id` (sama dengan `Last-Event-ID`), `template`, `data`, `createdAt`, `readAt` |
| `reconnect`    | sebelum koneksi ditutup karena batas waktu | `reason`, `lastEventId`                                                       |

Komentar `: heartbeat` dikirim tiap 15 detik agar proxy tidak memutus koneksi diam.

### Melanjutkan setelah putus

Kirim `Last-Event-ID` (header) atau `last_event_id` (query); query menang bila keduanya ada. Tanpa penanda, koneksi baru mulai dari peristiwa terbaru — riwayat tetap tersedia di `GET /me/notifications`. Penanda yang tidak dikenal, rusak, atau milik pengguna lain dijawab **400 `EVENTS_INVALID_LAST_EVENT_ID`** sebagai respons JSON biasa, sebelum satu byte pun dialirkan.

### Mengapa polling database, bukan bus internal

Baris ditulis oleh worker outbox, yang bisa berjalan di proses lain. Bus dalam memori akan menghilangkan peristiwa yang ditulis proses lain dan peristiwa yang terjadi saat deploy memindahkan klien. Membaca tabel memberi satu sumber kebenaran untuk semua instance. Polling berjalan 2 detik sekali dengan keyset `(created_at, id)`, cocok dengan indeks `notifications_recipient_cursor_idx`.

## Batasan

- **Satu arah.** Tidak ada WebSocket dan tidak ada kanal perintah; klien tetap memakai REST untuk semua aksi.
- **Tidak ada batas koneksi per pengguna** di dalam proses. Batas 15 menit adalah satu-satunya pembatas; penerapan cluster memerlukan limiter bersama (Redis).
- **Bergantung pada worker outbox.** Bila worker tidak berjalan, tidak ada baris `notifications` baru, sehingga aliran tetap diam meski API hidup.
- Tidak ada resume untuk baris yang sudah dihapus; saat ini `notifications` tidak punya jalur hapus.
