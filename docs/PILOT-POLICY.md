# Kebijakan implementasi pilot

Pada 12 November 2026 pengguna mendelegasikan pemilihan kebijakan awal kepada root dan menyetujui adapter sandbox/stub. Keputusan di bawah berlaku untuk pilot terkontrol; integrasi uang nyata belum diaktifkan. Dokumen ini melengkapi keputusan terbuka dalam REQUIREMENTS-API, bukan mengubah hasil audit prototype.

## Transaksi

- Currency awal IDR, nominal integer satuan terkecil, ditransmisikan sebagai string desimal; tidak ada floating point uang.
- Checkout satu tenant, satu slot, harga dan opsi dihitung ulang server. Kapasitas direservasi saat pembayaran wallet atomik, bukan saat quote. Quote tidak menjamin harga atau slot.
- Pilot tidak memungut komisi/fee platform atau pajak tambahan. Ini bukan pernyataan pajak atau biaya provider tidak berlaku. Biaya provider nyata dan kewajiban pajak harus dikonfigurasi sesuai kontrak sebelum aktivasi production.
- Dana pembayaran ditahan terpisah dari payable tenant. Release hanya setelah handover selesai dan tidak ada kasus operasional terbuka. Tidak ada release dari sekadar pembayaran sukses.
- Pembatalan operasional sebelum handover diputuskan pengelola kampus berizin dengan alasan. Pilot mendukung refund penuh satu kali; refund parsial dan otomatis setelah pickup tidak diaktifkan. Kasus setelah pickup tetap dapat dilaporkan untuk tinjauan manusia.
- Keputusan pembatalan membuat refund pending. Wallet hanya dikredit setelah hasil sukses terkonfirmasi dari adapter, diverifikasi dan dideduplikasi. Gagal/pending menuju retry/bantuan; tidak membuat saldo sementara.
- Payout sandbox diminta oleh pemilik terverifikasi ke rekening terverifikasi, maksimum dana tersedia dan harus positif. Dana di-hold atomik saat request; success/failure terkonfirmasi memindahkan/melepas hold tepat sekali. Tidak perlu persetujuan kampus per payout. Tidak ada jadwal batch otomatis pada pilot.
- No-show, penolakan proposal, timeout dan error provider tidak mengeksekusi refund atau produksi otomatis. Semua memerlukan jalur keputusan yang sah.

## Keamanan dan operasional

- OTP pilot berlaku 300 detik, maksimum lima percobaan, cooldown kirim ulang 60 detik; sesi maksimal 24 jam dengan refresh merotasi token. Nilai ini konfigurasi keamanan pilot dan bukan klaim kebijakan prototype.
- Provider delivery/QRIS/refund/payout/notifikasi disediakan melalui port yang dapat diuji. Stub terkontrol tidak mengirim OTP atau uang nyata, tidak mengembalikan OTP melalui API, dan tidak diizinkan di production.
- Endpoint webhook sandbox memerlukan autentikasi/signature tersendiri, reference, amount, currency dan state yang cocok. Tidak menerima instruksi saldo atau status dari buyer.
- Tidak ada auto-sanction dari skor risiko. Threshold pilot yang dipilih kelak hanya menambah antrean tinjauan dengan versi dan bukti, bukan mengubah order/saldo/akses.
- Scope kampus/tenant berasal dari resource dan membership database. Permission tambahan staf tidak dapat memberikan akses rekening/payout.

## Dasar dan batas integrasi

[Bank Indonesia menjelaskan QRIS dan skema MDR](https://www.bi.go.id/id/fungsi-utama/sistem-pembayaran/ritel/kanal-layanan/qris/default.aspx); karena klasifikasi merchant dan kontrak provider belum tersedia, implementasi tidak menebak tarif MDR production.

[Dokumentasi notifikasi Midtrans](https://docs.midtrans.com/docs/https-notification-webhooks) menjadi referensi teknis verifikasi callback; [dokumentasi refund](https://docs.midtrans.com/reference/refund-transaction) menjelaskan reference refund stabil untuk retry. Ini contoh provider, bukan keputusan memakai Midtrans. Refund ke sumber QRIS dan pengembalian saldo wallet merupakan proses berbeda; adapter production harus memetakan alur AntriPay tanpa menggandakan pengembalian nilai.

Kebijakan ini adalah keputusan desain pilot root berdasarkan delegasi pengguna, bukan rekomendasi hukum/akuntansi dari sumber tersebut. Aktivasi production tetap memerlukan provider, verifikasi merchant/rekening, pemetaan biaya/pajak, rekonsiliasi, backup/restore, retensi dan konfigurasi rahasia yang lengkap.
