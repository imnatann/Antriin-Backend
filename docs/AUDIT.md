# Audit backend

`AuditModule` mengekspor `AuditService.append(client, input)`. Service domain memanggilnya di dalam transaksi yang sama dengan perubahan bisnis, sesudah memeriksa permission dan scope. Aktor berasal dari sesi atau principal service yang tepercaya, bukan field request. Input menyimpan aktor, scope user/tenant/campus, aksi, jenis/ID target, alasan dan metadata aman; metadata tidak boleh memuat OTP/token/rekening/PII/provider payload mentah. Snapshot role/permission dan correlation ID dapat disimpan dalam metadata oleh service domain.

Audit append-only dilindungi trigger PostgreSQL dari update, delete dan truncate. Rollback domain juga membatalkan audit; jangan menulis audit keberhasilan sesudah transaksi domain terpisah. Ledger sendiri mempertahankan aktor/alasan immutable dan perubahan membership mempertahankan `access_audit_events`; keduanya bukan pengganti audit keputusan bisnis yang baru.

`GET /v1/campuses/:campusId/audit` memerlukan bearer dan permission `campus.audit.read` pada kampus itu. Hasil menggabungkan audit umum lingkup kampus/tenant serta audit membership kampus/tenant terkait, dengan cursor UUID dan limit maksimum 100. Audit wallet pribadi tidak otomatis terlihat oleh pengelola kampus. Endpoint ini tidak memberikan hak mengubah akses atau uang.

Jejak hanya ada untuk aksi yang telah memanggil service audit atau audit domain terkait. Modul bisnis yang masih scaffold tidak menghasilkan jejak audit rekaan; tiap implementasi baru wajib menambahkan audit atomik pada aksi kritisnya. Pemantauan/retensi eksternal dan praktik backup/restore production tetap pekerjaan operasional terpisah.
