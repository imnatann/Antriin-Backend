# Protokol Orkestrasi Agent Backend

Panduan ini mengatur pembagian kerja root orchestrator dan subagent untuk repository backend Antriin. Ini adalah adaptasi kerja tim dari panduan resmi agen; bukan hasil riset empiris atau klaim kemampuan khusus model Luna.

## Peran dan batas sesi

- Root menguraikan pekerjaan, menentukan penerimaan, mengoordinasikan dependensi, menetapkan pemilik file, mengintegrasikan hasil, memutuskan konflik, dan mengelola status Jira.
- Untuk setiap subagent, root memilih secara eksplisit `model=gpt-6-luna`, `fork_turns=none`, dan brief mandiri yang memuat konteks yang dibutuhkan. Jangan mengandalkan konteks percakapan root yang tidak ada di brief.
- Gunakan reasoning tinggi sebagai setelan awal sesuai panduan konfigurasi subagent; root dapat menyesuaikannya dengan kesulitan dan risiko tugas.
- Jangan melakukan nested delegation atau meminta subagent men-spawn agent lain tanpa arahan eksplisit dari root.
- Sesi ini menyediakan empat slot bersamaan termasuk root, sehingga maksimal tiga subagent aktif pada sesi ini. Ini batas kapasitas sesi, bukan angka permanen konfigurasi Codex.
- Bagian pekerjaan yang independen boleh berjalan paralel. Pekerjaan yang bergantung pada keputusan atau output lain harus dijalankan berurutan oleh root atau setelah dependensinya selesai.

## Kepemilikan dan review

- Setiap assignment mencantumkan file atau direktori yang menjadi milik agent. Satu file hanya memiliki satu implementer aktif pada satu waktu.
- Hindari perubahan bersamaan pada file yang sama. Jika tumpang tindih memang diperlukan, root menentukan urutan, memberi tahu pemilik terkait, dan mengintegrasikan perubahan.
- Implementer dan reviewer harus orang/agent berbeda. Reviewer memeriksa requirement, scope, jalur gagal, otorisasi, konsistensi data, dan bukti pemeriksaan; root tetap bertanggung jawab atas penerimaan akhir.
- Subagent tidak mengintegrasikan perubahan lintas pemilik atau memperbarui status penerimaan final kecuali root menugaskannya secara eksplisit.

## Definition of Ready

Tugas siap diberikan saat:

1. Hasil yang diminta dan alasan tugas jelas.
2. Brief merujuk requirement atau issue Jira backend yang tepat, memisahkan ketentuan yang disepakati dari usulan dan keputusan terbuka.
3. File milik agent, batas perubahan, dependensi, kriteria penerimaan, dan bentuk laporan ditentukan.
4. Pemeriksaan yang diharapkan proporsional dengan perubahan; untuk skema/transaksi, rencana verifikasi PostgreSQL dinyatakan.

## Definition of Done dan acceptance

Pekerjaan dapat diterima bila kriteria assignment terpenuhi, perubahan berada dalam scope, hasil review independen selesai, dan pemeriksaan yang relevan benar-benar dijalankan serta dilaporkan. Perubahan perilaku API memperbarui dokumentasi/OpenAPI; perubahan aturan bisnis menyertakan test bermakna sesuai panduan repo. Untuk schema/query/transaksi, stub saja tidak cukup sebagai bukti constraint atau locking PostgreSQL. Keterbatasan infrastruktur dan pekerjaan tersisa harus disebutkan; jangan menyatakan migrasi, integrasi, build atau CI berhasil tanpa bukti eksekusi.

Laporan menyebut file yang berubah, keputusan/asumsi yang dipakai, pemeriksaan beserta hasilnya, risiko/hal tersisa, dan status acceptance yang disarankan. Root menetapkan `Accepted` setelah integrasi dan verifikasi akhir; status subagent sendiri bukan penerimaan final.

## Jira: cakupan backend

- Jira adalah proyek bersama. Assignment dan pembaruan dalam protokol ini hanya mencakup issue backend/API/worker/database yang relevan.
- Root mengelola issue, dependensi, status, dan penerimaan. Subagent hanya memperbarui issue yang secara eksplisit ditugaskan kepadanya dan hanya dengan informasi yang dapat dibuktikan.
- Jangan mengubah shared epics atau issue frontend, memindahkan pekerjaan lintas cakupan, atau menutup issue duplikat secara otomatis. Tandai/rujuk kemungkinan duplikat kepada root untuk diputuskan.
- Tautkan perubahan ke issue backend yang sudah ada. Jika belum ada, root memutuskan pembuatan issue dan menjaga backlog backend di [docs/BACKEND-BACKLOG.md](BACKEND-BACKLOG.md).
- Status kerja yang disarankan: `Ready` (siap dikerjakan), `In progress`, `Review`, `Accepted` (root menerima setelah bukti dan integrasi), atau `Blocked` dengan hambatan dan kebutuhan keputusan yang jelas.
- Status tersebut adalah label operasional, bukan nama workflow Jira yang diasumsikan tersedia. Root membaca transisi issue lalu memetakannya ke workflow yang ada. Pada pemeriksaan 12 November 2026, KAN-64 menyediakan `To Do`, `In Design`, `User Testing`, `Approved` dan `Live`; penerimaan dokumentasi dapat memakai `Approved`, sedangkan `Live` tidak digunakan untuk menyiratkan deployment yang belum terjadi.

## Keputusan produk dan data sensitif

- Jangan mengubah requirement terbuka menjadi keputusan produk. Khususnya jangan menentukan fee, settlement, batas refund, payout, atau aturan finansial baru tanpa dasar kebutuhan pengguna. Ajukan pertanyaan/opsi kepada root dan catat asumsi yang berdampak pada produk.
- Pertahankan aturan produk yang disepakati dalam `AGENTS.md` dan `docs/REQUIREMENTS-API.md`, termasuk pembayaran sebelum persiapan, proposal jadwal perlu persetujuan pembeli, refund hanya setelah konfirmasi sukses provider, dan indikasi AI memerlukan tinjauan manusia.
- Enforce permission dan kepemilikan resource di server, termasuk scope buyer/tenant/campus dan pekerjaan background. Jangan mempercayai role, ID, harga, saldo atau status dari klien sebagai otoritas.
- Jangan menaruh `.env`, credential, OTP, token, payload provider sensitif, atau nomor rekening penuh di commit, log, prompt agent, Jira, atau laporan. Gunakan data sintetis/sandbox dan masking; jangan memakai transaksi uang nyata untuk pemeriksaan rutin.
- Aksi finansial, perubahan akses dan keputusan pengelola memerlukan audit sesuai requirement.

## Template assignment

```text
Tugas:
Hasil yang diharapkan:
Konteks requirement/issue backend:
File milikmu:
Batasan dan keputusan terbuka:
Kriteria penerimaan dan pemeriksaan:
Laporan: file/diff, asumsi, pemeriksaan beserta hasil, risiko/pekerjaan tersisa,
         dan status acceptance yang disarankan.
```

## Template hasil subagent

```text
Status yang disarankan: Review | Blocked | Accepted oleh root
Perubahan: [file dan ringkasan]
Bukti: [pemeriksaan yang benar-benar dijalankan dan hasil]
Asumsi/keputusan terbuka: [daftar atau "tidak ada"]
Risiko/pekerjaan tersisa: [daftar atau "tidak ada"]
```

## Sumber

- [OpenAI Agents API: Multi-agent](https://developers.openai.com/api/docs/guides/agents-api/multi-agent) — panduan umum tentang pembagian subtask, kejelasan hasil, dependensi, dan koordinasi file.
- [OpenAI: Agent configuration and subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) — panduan konfigurasi dan penggunaan subagent.

Aturan model Luna, brief mandiri, kepemilikan file, Jira backend-only, kapasitas sesi, dan acceptance di dokumen ini adalah adaptasi untuk tim/repo ini. Sumber di atas merupakan panduan resmi, bukan benchmark empiris Luna atau jaminan hasil proyek.
