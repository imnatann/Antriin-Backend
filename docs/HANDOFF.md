# Checkpoint dan lanjutan backend

Checkpoint 12 November 2026 dibuat atas permintaan pengguna sebelum batas penggunaan. Tujuan awal tetap menyelesaikan seluruh backend, dengan root sebagai supervisor dan subagent **hanya GPT-6 Luna**. Semua fitur belum selesai; jangan menandai seluruh proyek selesai.

## GitHub dan bukti diterima

- Branch terverifikasi: [codex/backend-implementation](https://github.com/BagasDwikiPurnomo/Antriin-Backend/tree/codex/backend-implementation).
- Fondasi awal `f8eb57e`, kebijakan/error/config/test runner `44afdfa`, domain foundation `9ab4a50` sudah di-push.
- `9ab4a50`: auth/session/campus verification/IP rate limit, scoped staff access, immutable double-entry ledger/read API, transactional outbox/in-app notification, audit kampus.
- Exact staged snapshot diekspor ke direktori sementara, bukan memakai file wave2 yang sedang ditulis. Node24 typecheck, lint, format dan build lulus; `npm run test:integration` menerapkan migrasi0000..0005 pada PostgreSQL baru dan menjalankan44/44 tes dengan Redis/BullMQ nyata, tanpa skip. [CI checkpoint sukses](https://github.com/BagasDwikiPurnomo/Antriin-Backend/actions/runs/43134757693).
- Branch penyimpanan draft wave2: [codex/backend-wip-20261112](https://github.com/BagasDwikiPurnomo/Antriin-Backend/tree/codex/backend-wip-20261112). WIP bukan fitur siap pakai dan tidak boleh di-deploy/dianggap sudah dimigrasikan.
- Pengguna mengizinkan commit/push berkala dan pembaruan Jira backend. Tidak ada merge/push force/reset database/deployment uang nyata.

## WIP yang harus dibaca ulang

| Slice / implementer Luna                     | File dan keadaan aktual                                                                                                                          | Pekerjaan berikut                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Katalog/availability, `orchestration_design` | `schema/catalog.ts`; campus/tenant controllers/services/DTO; availability controller/service/DTO dan module wiring; `CatalogService.quote` draft | Review keseluruhan, katalog CRUD/discovery/search/recommendations controller/DTO, docs, tests; ekspor schema lalu generate/review migrasi; PostgreSQL capacity/locking/scope tests |
| Order/pickup, `backend_scope`                | Hanya draft `schema/orders.ts`; belum service/controller/tests/docs/migrasi                                                                      | Review FK slot/tenant/campus dan snapshot; implement checkout/state/proposal/pickup secara bertahap                                                                                |
| Payments, `quality_baseline`                 | Hanya draft `schema/payments.ts` untuk topup intents, request outbox dan provider events                                                         | Implement adapter stub, request processor, HTTP intent/webhook, konfigurasi/raw body, tests/migration/docs                                                                         |

Ketiga schema WIP belum diekspor dari `src/database/schema/index.ts`, belum menghasilkan migrasi dan belum diuji terhadap PostgreSQL. Root memperbaiki satu TS7006 callback validasi quote saat menyimpan; hasil typecheck WIP dicatat terpisah, bukan penerimaan integrasi. Modul campus/tenant/availability sudah mempunyai wiring WIP yang membutuhkan schema tersebut; jangan menggunakan branch WIP sebagai aplikasi operasional.

## Kontrak antar implementer

- `AuthGuard` dan `CurrentUser` berada bersama di `modules/auth/auth.guard.ts`; principal `{userId,sessionId}`. AuthModule mengekspor AuthService/Guard. Default delivery503; capturing OTP port hanya test. Profil `/me`, transport sandbox operasional dan worker `drainOtpDeliveries()` belum selesai.
- `AccessService.requireTenant(userId,tenantId,permission,client?)` / `requireCampus(...)` membaca membership/scope aktif; gunakan client transaksi untuk aksi kritis agar revoke terserialisasi. Kitchen/pickup tidak mendapat finance/bank/payout. Provisioning owner/campus admin masih perlu jalur terkontrol.
- `WalletService.getOrCreateWallet`, `ensureSystemAccount`, `postTransfer(input,client?)` menyatu dengan transaksi pemanggil. Debit mengurangi, credit menambah. Input posting memerlukan actor/reason/idempotency/ref; hasil uang string desimal. GET saldo read-only; wallet publik pilot IDR.
- `CatalogService.quote(client,tenantId,slotId,items)` dirancang mengembalikan snapshot server, tenant/campus/timezone, slot/version, item+option versions, subtotal/total/currency dan canonical quoteHash. Input item `{menuItemId,quantity,optionIds}`. Tidak reserve saat quote. Periksa kode draft sebelum menganggap kontrak final.
- Availability dirancang menyediakan reserve/release/consume/moveReservation dengan PoolClient/orderId; checkout memeriksa replay **sebelum** re-quote, lalu quote hash, reserve, debit, order/payment/snapshot/event/audit/outbox dalam satu transaksi. Proposal acceptance memindahkan kapasitas atomik.
- `AuditService.append(client,{actor,scopeType,scopeId,action,targetType,targetId,reason,metadata})` internal; caller harus authorize dan mengambil actor dari sesi/service. Jangan masukkan rahasia/PII/provider payload pada metadata. Audit kampus memerlukan `campus.audit.read` dan mencakup access audit.
- `OutboxService.append(client,{eventKey,eventType,aggregateType,aggregateId,recipientIds})` internal. Event key stabil per perubahan bisnis; penerima dihitung server dari resource yang telah diotorisasi, bukan body HTTP. Retry hash sama mengembalikan event sama, hash berbeda409. Worker domain hanya menghasilkan in-app notification; wallet outbox dan OTP delivery tetap alur terpisah.

## Keputusan pilot dan konfigurasi yang masih perlu ditambahkan

Pengguna menyetujui sandbox/stub dan mendelegasikan keputusan awal kepada root; [PILOT-POLICY.md](PILOT-POLICY.md) adalah acuan. Currency IDR dengan nominal rupiah bulat/string, satu tenant/checkout, tidak memungut platform fee/komisi/pajak tambahan pilot; ini bukan klaim biaya provider/pajak nyata nol. Payable hanya sesudah handover tanpa kasus terbuka; refund penuh melalui pengelola+provider success; payout sandbox dari dana tersedia ke rekening pemilik terverifikasi.

Rencana order yang telah disepakati root tetapi **belum diimplementasikan/ditambahkan ke Joi atau env example**:

- `ORDER_PROPOSAL_TTL_SECONDS=600`, bounds60..3600.
- `ORDER_PREPARATION_LEAD_SECONDS=900`, bounds0..7200. Persiapan harus aksi eksplisit berizin dan `now >= slot.startsAt - lead`; tidak otomatis.
- `PICKUP_CREDENTIAL_TTL_SECONDS=7200`, bounds300..86400; expiry `max(readyAt,slot.endsAt)+TTL`. Expiry tidak membatalkan/mengembalikan uang otomatis; jalur bantuan/rotasi credential aman masih perlu implementasi.

Rencana payments yang belum diimplementasikan/ditambahkan ke konfigurasi:

- `PAYMENTS_PROVIDER_MODE=disabled|sandbox`, default disabled; production menolak sandbox.
- `PAYMENTS_TOPUP_MIN_MINOR=1000`, `PAYMENTS_TOPUP_MAX_MINOR=2000000`, IDR rupiah bulat; `PAYMENTS_SANDBOX_WEBHOOK_SECRET` minimal32 karakter, wajib bila sandbox.
- Nest `rawBody:true`, HMACSHA256 atas `timestamp + '.' + exactRawBody`, header signature terpisah dan timestamp ±300detik. `occurredAt` event historis dapat lama untuk rekonsiliasi late success; tidak sama dengan timestamp autentikasi request.
- Signature/ref/amount/currency/state/dedupe harus lolos sebelum kredit. Provider call di luar lock; simpan outbox atomik; webhook kredit ledger tepat sekali. Jangan menulis adapter Midtrans/QRIS produksi tanpa provider/kontrak/kredensial.

## Jira dan urutan lanjut

Site [Antriin Jira](https://naassyifan-1794411535927.atlassian.net), project KAN, cloudId `64cb32c2-86da-4b71-83e0-fe81806918bb`.

- KAN-24 access dan KAN-66 ledger **Approved** sesuai scope; tidak Live.
- KAN-65 **User Testing**; profil/provider/dispatcher masih perlu dilanjutkan.
- KAN-18/19/29/30/32/67/70 **In Design**. KAN-67 draft belum dimigrasikan; KAN-70 hanya outbox/notifikasi/audit yang telah diterima sebagai slice, review/risk/reporting belum selesai.
- KAN-31 refund, KAN-68 kasus/pickup, KAN-69 settlement/payout masih belum diterima. Jangan menutup issue shared/frontend/duplikat.
- Lanjutkan katalog/availability+tests terlebih dahulu, lalu checkout/order serta topup sandbox paralel pada file terpisah, berikutnya pickup/proposal/cases/refund, settlement/payout, review/risk/recommendations/reporting, profil/provisioning/worker dan pemeriksaan operasional.

## Cara melanjutkan dengan aman

1. Baca AGENTS, README, requirements, policy dan handoff ini; periksa branch/status/remote terbaru. Semua subagent harus Luna dengan brief mandiri dan satu implementer per file. Jangan gunakan nested delegation tanpa arahan root.
2. Gunakan Node24, bukan Node26 shell default. Pada sesi ini Node24 tersedia di `/Users/macbook/.npm/_npx/387698761821791d/node_modules/node/bin`; verifikasi lokasinya sebelum dipakai kembali.
3. `npm run test:integration` membuat PG/Redis ephemeral dan menerapkan migrasi tanpa menimpa `.env`. Jangan menganggap DATABASE_URL pengguna menunjuk database lokal. Jangan mengubah migrasi0000..0005 yang sudah diterapkan; schema baru harus menghasilkan migrasi baru.
4. Review draft, lengkapi DTO/Swagger/docs, lalu verifikasi PostgreSQL untuk transaksi/constraints/locking. Snapshot commit dapat diuji terpisah dari perubahan agent yang belum selesai dengan `git write-tree`/`git archive` dan dependency yang sesuai; jangan mengklaim WIP ikut lolos44tes checkpoint.
5. Commit/push per bagian setelah review/checks, cantumkan hash dan bukti pada Jira. Simpan WIP secara eksplisit jika sesi terputus; jangan menyatakan deployment/provider nyata atau seluruh project selesai tanpa eksekusi.
