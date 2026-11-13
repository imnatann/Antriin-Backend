# Event domain dan notifikasi pilot

`OutboxModule` mengekspor `OutboxService.append(client, input)` untuk dipanggil service domain di dalam transaksi PostgreSQL yang sama dengan perubahan bisnis. Input wajib memuat `eventKey`, `eventType`, `aggregateType`, `aggregateId`, dan `recipientIds`.

- `eventKey` harus stabil dan unik untuk event bisnis, misalnya `order:<uuid>:status:<version>`. Retry key dengan isi sama mengembalikan event lama; isi berbeda ditolak. Idempotency operasi domain tetap wajib.
- Service domain menghitung penerima dari resource dan membership yang telah diotorisasi, di dalam transaksi tersebut. Jangan menyalin `recipientIds` dari request klien. Outbox adalah primitive internal, bukan endpoint publik atau pengganti pemeriksaan scope domain.
- Payload hanya berisi referensi. OTP, token, alamat email/nomor telepon, rekening dan payload provider tidak disebarkan melalui event ini.
- Event identity dan isi immutable; timestamp publish/delivery/failure hanya bergerak maju. Event tidak dapat dihapus. Efek uang tetap melalui ledger/service domain; pengiriman notifikasi tidak memindahkan uang.

Worker terpisah menjalankan `OutboxDispatcher` dan `OutboxProcessor`. Dispatcher membaca event pending, menerbitkan job BullMQ dengan ID stabil, lalu mencatat publish. Ia tidak memegang transaksi/row lock PostgreSQL selama akses Redis. Kegagalan sebelum publish tetap pending; crash setelah publish dapat mengulang publish dengan ID sama. Processor mengunci event, memasukkan satu notifikasi per penerima/event, kemudian menandai delivery dalam satu transaksi. Redelivery atau dua worker tidak menggandakan notifikasi.

Queue mencoba ulang tiga kali dengan exponential backoff sesuai JobsModule. Job invalid ditolak permanen; event invalid atau retry yang habis ditandai failed, tersimpan untuk investigasi dan tidak dihapus otomatis. Operator memeriksa event dan failed job sebelum merencanakan pemulihan yang berjejak audit. Tidak ada endpoint publik untuk membuka kembali event terminal. Pantau usia event unpublished dan failed jobs saat operasional; dashboard/alert eksternal belum disediakan.

Pilot menyediakan notifikasi dalam aplikasi melalui `GET /api/v1/me/notifications` (cursor UUID, maksimum 50) dan `POST /api/v1/me/notifications/:id/read` (204). Semua query/mutasi dibatasi recipient dari sesi; read dapat diulang tanpa mengubah waktu pertama dibaca. Template menunjuk event dan referensi resource; frontend harus mengambil detail melalui endpoint domain yang tetap memeriksa akses. Email/push/WhatsApp bisnis belum dikirim oleh worker ini.

Outbox ledger `wallet_outbox_events` dan delivery OTP terenkripsi adalah alur terpisah. Ledger outbox saat ini jejak integrasi durable dan belum dipublikasikan oleh dispatcher notifikasi; OTP mempunyai lease/retry sendiri di AuthService. Jangan menyatakan kedua alur tersebut telah tersambung ke provider nyata.
