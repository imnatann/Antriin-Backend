# Review independen — slice settlements, payouts & rekening bank (commit `101feca`)

Reviewer: subagent reviewer independen (read-only). Tanggal: 13 November 2026.
Branch: `codex/backend-wip-20261112`. Objek: `src/modules/settlements/**`, `src/modules/payouts/**`,
`docs/modules/settlements.md`, `docs/modules/payouts.md`, `test/settlements*.spec.ts`,
`test/payouts*.spec.ts`, `test/bank-accounts.spec.ts`, serta perubahan aditif di
`src/modules/orders/orders.service.ts` (`getOrderSettlementContext`),
`src/modules/cases/cases.service.ts` (`hasOpenCasesForOrder`, `releaseAfterCaseDecision`),
`src/modules/pickup/pickup.service.ts` (`releaseAfterHandover`),
`src/modules/wallet/wallet.service.ts` (`lockSystemAccount`), wiring
`src/jobs/jobs.module.ts` + `src/worker.module.ts`.

Acuan yang dibaca: `AGENTS.md`, `docs/ORCHESTRATION.md`, `docs/reviews/wave1-decisions.md` (D1–D18),
`docs/PILOT-POLICY.md`, `docs/REQUIREMENTS-API.md` §3.8/§4/§7.4–§7.7,
`docs/design/settlement-payout.md`, `src/database/schema/settlements.ts`,
`src/database/schema/payouts.ts`, `drizzle/0009_flawless_whirlwind.sql`.

## Verdict

**LULUS DENGAN CATATAN** — layak `Approved` setelah F1 dan F2 ditangani, atau keduanya diterima root
sebagai follow-up eksplisit. **Tidak ada BLOCKER**: alur uang benar secara desain maupun implementasi,
semua perpindahan lewat satu `postTransfer` seimbang, "tepat sekali" dijaga berlapis (UPDATE
kondisional + CHECK `payouts_ledger_legs_check` + idempotensi ledger + dedupe provider event + unique
per order), dan seluruh test yang ada lulus di PostgreSQL nyata.

| Severity | Jumlah |
| -------- | ------ |
| BLOCKER  | 0      |
| MAJOR    | 2      |
| MINOR    | 7      |

| #   | Checklist                                                                            | Verdict                      |
| --- | ------------------------------------------------------------------------------------ | ---------------------------- |
| 1   | Uang tepat sekali (release idempoten, hold dipindah/dilepas tepat sekali)            | **OK**                       |
| 2   | Ledger (satu postTransfer seimbang, namespace berbeda, tanpa tulis langsung)         | **OK**                       |
| 3   | Saldo negatif (lock + BigInt, jalur payable/hold negatif)                            | **OK** (catatan di §3)       |
| 4   | Otorisasi (pemilik terverifikasi, staf ditolak, scope, 404 vs 403)                   | **OK**                       |
| 5   | Rekening bank (AES-GCM + HMAC + masking, baris baru, verifikasi 503)                 | **OK** (F8)                  |
| 6   | Kontrak lintas slice (hook tidak menggagalkan handover/keputusan, 40P01, forwardRef) | **OK** (F2 untuk bukti test) |
| 7   | State machine (status/CHECK dua arah, transisi ilegal, satu payout aktif)            | **OK**                       |
| 8   | Validasi/error/OpenAPI                                                               | **OK** (F7)                  |
| 9   | Kualitas test                                                                        | **MAJOR** (F1, F2) + F5, F6  |
| 10  | Kepatuhan D18 (Q1–Q10)                                                               | **OK**                       |

## Temuan

| id  | severity | file:baris                                                                                                                                                                       | masalah                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | dampak                                                                                                                                                                                                                                                                                                                                                                               | usulan                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | MAJOR    | `drizzle/0009_flawless_whirlwind.sql`; `src/database/schema/settlements.ts:60-101`, `src/database/schema/payouts.ts:80-208`; tidak ada `test/settlement-schema.spec.ts`          | Tidak ada satu pun test untuk constraint migrasi 0009: `grep payouts_ledger_legs_check/payouts_one_active_per_tenant_uq/settlements_one_per_order_uq` di `test/` kosong, dan `test/schema-integrity.spec.ts` hanya menguji 0007 (R1-01..R1-17). Kriteria penerimaan T1 desain (§2.5 butir 1–10, `docs/design/settlement-payout.md:619-623`) mewajibkan test integritas ini.                                                                                                                                            | Penjaga DB untuk "tepat sekali" (`payouts_ledger_legs_check`), "satu payout aktif per tenant", FK komposit lintas tenant, status↔timestamp settlement, satu default rekening, dan FK `payout_allocations` hanya terbukti manual (lihat §Test reviewer). Regresi migrasi/skema tidak tertangkap CI — padahal ini lapisan terakhir yang mencegah dua leg terminal atau payout paralel. | Pindahkan probe SQL reviewer (tabel di bagian test) ke `test/settlement-schema.spec.ts` mengikuti pola `schema-integrity.spec.ts` (assert SQLSTATE 23514/23505/23503), minimal 10 constraint §2.5 butir 1–10.                                                                                                                                                                                                                            |
| F2  | MAJOR    | `src/modules/pickup/pickup.service.ts:144-148,591-602`; `test/pickup.spec.ts:128-134`                                                                                            | Pemicu release utama (D18 Q2a: handover) tidak pernah dieksekusi end-to-end di test. `test/pickup.spec.ts` tidak menyebut settlements sama sekali dan mengonstruksi `new PickupService(database, access, orders, audit, configService)` tanpa argumen `settlements`, sehingga `this.settlements` undefined dan hook release **selalu dilewati** pada seluruh 16 test pickup yang lulus. Karena injeksi bersifat `@Optional()` dan pemanggilan dibungkus `catch {}`, kegagalan wiring tidak menghasilkan error apa pun. | Satu-satunya jalur yang benar-benar melepas uang tenant ke payable tidak punya bukti otomatis; regresi wiring (mis. `forwardRef`/import modul hilang) akan lolos CI dan membuat dana tertahan di escrow tanpa alarm, tanpa test merah.                                                                                                                                               | Tambahkan test di `test/pickup.spec.ts` (atau spec baru) yang mengonstruksi PickupService **dengan** SettlementsService: (a) handover order `ready_for_pickup` completed tanpa kasus → saldo payable naik tepat `amount_minor` + satu baris `settlements`; (b) release gagal (wallet stub melempar) → handover tetap sukses/COMMIT + audit `tenant.payable.release_failed`. Pertimbangkan menghapus `@Optional()` dan menyesuaikan test. |
| F3  | MINOR    | `src/modules/payouts/payouts.service.ts:796-846,1773-1776`, `src/modules/payouts/payout.adapter.ts:111-120`                                                                      | Mode provider dimatikan saat payout sudah `requested`/`processing`: `SandboxPayoutAdapter.assertSandbox` melempar `ServiceUnavailableException`, `providerErrorCode` mengklasifikasikannya sebagai transien (`PROVIDER_REQUEST_FAILED`), sehingga processor melakukan 5 percobaan + backoff lalu `markNeedsAssistance` (dana tetap di hold, outbox `dead`). Slice refunds mengklasifikasikan kondisi deterministik yang sama sebagai kegagalan PERMANEN (lihat pesan commit `101feca`).                                | Payout yang belum sempat diproses saat operator mematikan mode akan menggantung: uang tertahan di `tenant.payout.hold.<tenant>` dan tenant tidak bisa mengajukan payout baru (`payouts_one_active_per_tenant_uq`) sampai rekonsiliasi manual. Tidak ada endpoint/service untuk menyelesaikannya.                                                                                     | Perlakukan `PAYOUT_PROVIDER_DISABLED` sebagai `PermanentPayoutRequestError` (gagal → hold kembali ke payable, tanpa 5 percobaan sia-sia), atau dokumentasikan eksplisit di `docs/modules/payouts.md` bahwa mematikan mode menahan dana sampai rekonsiliasi.                                                                                                                                                                              |
| F4  | MINOR    | `src/database/schema/payouts.ts:81,129-131` vs `docs/design/settlement-payout.md:183`                                                                                            | Desain menyebut `bank_accounts UNIQUE (tenant_id, id)` "untuk FK komposit payout", tetapi `payouts.bank_account_id` hanya FK tunggal ke `bank_accounts(id)`; unique `(tenant_id, id)` ada tetapi tidak dipakai sebagai target FK komposit.                                                                                                                                                                                                                                                                             | Database tidak mencegah baris `payouts` menunjuk rekening tenant lain; isolasi bergantung sepenuhnya pada `where id = $1 and tenant_id = $2` di service (`payouts.service.ts:303-320`). Deviasi dari desain ini tidak dicatat di dokumen modul.                                                                                                                                      | Tambahkan FK komposit `(tenant_id, bank_account_id) -> bank_accounts(tenant_id, id)` pada migrasi berikutnya, atau catat deviasinya di `docs/modules/payouts.md` (bagian invariant DB) sebagai pertahanan berlapis yang belum ada.                                                                                                                                                                                                       |
| F5  | MINOR    | `src/modules/payouts/payout-request.processor.ts:67-99`, `src/modules/payouts/payouts.service.ts:664-694`                                                                        | Tidak ada test wiring queue payout: jobId nonce (`payout-request-<id>-<attempts>-<nonce>`), penghapusan job `failed` lalu re-add, alarm baris due > 120 detik, dan validasi payload `UnrecoverableError` tidak diuji; tidak ada satu pun test yang menyebut `PayoutRequestDispatcher` atau `listDuePayoutRequests`. Precedent: `test/refunds-queue.spec.ts` dan `test/payments-queue.spec.ts` ada.                                                                                                                     | Perbaikan pola P2-01 (nonce agar baris due tidak macet) dan anti-stall untuk payout tidak terlindungi; regresi membuat payout menggantung tanpa alarm.                                                                                                                                                                                                                               | Tambahkan `test/payouts-queue.spec.ts` mengikuti `refunds-queue.spec.ts` (Redis test): jobId berubah setelah state berubah, job failed dihapus + di-enqueue ulang, payload invalid menjadi `UnrecoverableError`.                                                                                                                                                                                                                         |
| F6  | MINOR    | `src/modules/settlements/settlements.module.ts:32`, `src/modules/cases/cases.module.ts:23`, `src/modules/pickup/pickup.module.ts:35`, `src/modules/payouts/payouts.module.ts:39` | Siklus DI `settlements <-> cases` (forwardRef) dan injeksi opsional ke pickup/payouts tidak diverifikasi test apa pun: tidak ada test yang mem-boot `AppModule` atau `WorkerModule`, atau mem-boot modul-modul ini bersama; semua spec HTTP memakai service stub.                                                                                                                                                                                                                                                      | Regresi wiring hanya terlihat saat boot manual (klaim commit "verified by booting the worker"), bukan di CI; digabung F2, kegagalan wiring bisa tidak terdeteksi sama sekali. Reviewer sudah memverifikasi siklus ini resolve (lihat bagian test), jadi risikonya regresi, bukan kondisi sekarang.                                                                                   | Tambahkan satu smoke test boot (`Test.createTestingModule({ imports: [PickupModule, CasesModule, SettlementsModule, PayoutsModule] })` + resolve service) atau boot `AppModule` dengan env test.                                                                                                                                                                                                                                         |
| F7  | MINOR    | `src/modules/payouts/payouts.service.ts:454-457,1531-1547`; `src/modules/payouts/payouts.controller.ts:344`                                                                      | `replayed` pada hasil `requestPayout` diisi dari flag ledger (`posted.replayed`), bukan dari "baris payout sudah ada", dan controller membuang field itu sehingga replay `POST /payouts` tetap 201 tanpa penanda apa pun.                                                                                                                                                                                                                                                                                              | Klien tidak bisa membedakan request baru vs replay (padahal hold tidak terjadi dua kali), dan nilai `replayed` internal menyesatkan pembaca kode/test.                                                                                                                                                                                                                               | Kembalikan `replayed` dari jalur `existing`/`replay()` saja, dan kirimkan sebagai header (`Idempotent-Replayed: true`) atau field `meta.replayed`; dokumentasikan di Swagger.                                                                                                                                                                                                                                                            |
| F8  | MINOR    | `src/modules/payouts/bank-accounts.service.ts:143-152,201-210,340-380`                                                                                                           | Dua celah pertahanan berlapis: (a) `createBankAccount`/`replaceBankAccount` menjalankan `normalizeInput` dan `bankAccountKeys` (503 bila `AUTH_ENCRYPTION_KEY` tidak ada) **sebelum** `requireTenant`, sehingga bukan-anggota menerima 400/503 alih-alih 403 — berbeda dari `requestVerification` yang sengaja otorisasi lebih dulu; (b) `markVerified` tidak mensyaratkan `status='active'`, jadi rekening `disabled` bisa ditandai `verified`.                                                                       | Tidak ada kebocoran data, tetapi pola "otorisasi dulu" tidak konsisten dan status verifikasi bisa tidak konsisten dengan status rekening (mis. diverifikasi setelah dinonaktifkan), yang membingungkan audit.                                                                                                                                                                        | Pindahkan `requireTenant` ke awal method (sebelum normalisasi/enkripsi), dan tambahkan guard `status='active'` (409 `BANK_ACCOUNT_NOT_ACTIVE`) di `markVerified`.                                                                                                                                                                                                                                                                        |
| F9  | MINOR    | `src/modules/access/access.service.ts:36`; tidak ada route `campuses/:campusId/payouts`/`.../settlements`                                                                        | REQUIREMENTS §3.8.7 ("Pengelola kampus dapat memantau payout sesuai izin") dan desain §7 (`GET /campuses/:campusId/payouts` dengan `campus.payouts.read`, `GET /campuses/:campusId/settlements` dengan `campus.transactions.read`) belum diimplementasikan; permission `campus.payouts.read` ada di inventaris tetapi tidak punya konsumen, dan `docs/modules/payouts.md` bagian "Belum ada" tidak mencatat penundaan ini.                                                                                             | Fitur pemantauan kampus (yang eksplisit di requirement, bukan hanya usulan desain) tidak ada dan status penundaannya tidak terlihat oleh root/produk.                                                                                                                                                                                                                                | Implementasikan dua endpoint baca (read-only, selalu tersamarkan, tanpa kemampuan memindahkan dana) atau catat eksplisit di `docs/modules/payouts.md`/`docs/modules/settlements.md` bahwa pemantauan kampus ditunda beserta alasannya.                                                                                                                                                                                                   |

### Catatan yang diterima (bukan temuan)

- **Deadlock 40P01 antara handover dan keputusan kasus memang nyata, tetapi terkendali** — dan ini
  sudah didokumentasikan jujur di `docs/modules/settlements.md:163-169`. Reviewer mereproduksinya
  (lihat §Test reviewer): kedua transaksi tetap `COMMIT`, hanya release yang tertunda + audit
  `tenant.payable.release_failed` dengan `errorCode: 40P01`. Konsekuensinya: karena Q2c (job penyapu)
  ditunda, release yang tertunda hanya bisa dipulihkan lewat pemicu berikutnya (keputusan kasus lain)
  atau retry manual; dana tetap di escrow (aman, tidak hilang). Ini konsekuensi keputusan D18, bukan bug.
- **Test konkurensi payout bersifat serial per ronde** (`test/payouts.spec.ts:583-654`): karena
  `payouts_one_active_per_tenant_uq` hanya mengizinkan satu payout aktif, "N payout paralel" tidak
  mungkin benar-benar paralel untuk satu tenant; test menguji invariant (payable/hold tidak negatif,
  tepat 3 payout terdanai) tetapi tidak menekan jalur `lock + BigInt` dengan kontensi nyata. Ini
  batasan model yang wajar, bukan test lemah yang bisa diperbaiki tanpa mengubah produk.
- `settlements` tidak punya `voidSettlementForRefund` (disebut di desain §6): refund dan release
  saling eksklusif per order (release menolak order yang punya baris refund, refund hanya untuk order
  `cancelled`), dan hal ini sudah dicatat di `docs/modules/settlements.md:216-218`.
- Namespace referensi release memakai `settlement_release` + `orderId` (bukan `settlement` +
  `settlementId` seperti usulan desain §4.2). Ini perbaikan yang benar: baris settlement baru ada
  setelah posting, jadi memakai `orderId` menghindari kebutuhan id sebelum insert; dokumen modul sudah
  mencatatnya (`docs/modules/settlements.md:73-74`).
- `getFinanceSummary`/feed memakai `to_char(... US ...)` (D7) dan uang sebagai string — konsisten
  dengan D7/D12.8; `availableMinor`/`heldMinor` boleh negatif di skema OpenAPI, yang jujur.

## Sudah benar (dengan bukti)

### 1. Uang tepat sekali

- Release idempoten dua lapis: cek baris settlement lebih dulu → `already_released` tanpa posting
  (`settlements.service.ts:166-177`), dan INSERT di dalam savepoint yang memetakan 23505
  `settlements_one_per_order_uq` menjadi `already_released` (`:255-289`) sehingga release paralel
  tidak meninggalkan transaksi pemanggil dalam keadaan abort.
- Idempotensi ledger: scope `settlements.release`, key = `orderId`, reference
  `settlement_release`/`orderId` (`:232-249`) → posting ulang mengembalikan transaksi yang sama
  (`replayed=true`), bukan transfer kedua (`wallet.service.ts:322-350`).
- Hold dipindah/dilepas tepat sekali: `payouts_ledger_legs_check` menolak leg terminal kedua
  (`src/database/schema/payouts.ts:192-198`, diverifikasi reviewer lewat probe SQL), ditambah UPDATE
  kondisional `where status='processing'`/`='requested'` + `rowCount === 1`
  (`payouts.service.ts:528-542,1026-1044,1170-1188`), dedupe provider event `on conflict (provider,
event_id) do nothing` (`:973-990,1123-1140`), dan lease/fencing outbox (`:1471-1488`).
- Tidak ada jalur kredit dari input klien: amount release diambil dari `order_payments.amount_minor`
  yang berstatus `succeeded` (`settlements.service.ts:203-219`); amount payout dari klien tetapi
  hanya dipakai sebagai **debit** (hold) dan dibatasi saldo payable (`payouts.service.ts:345-354`).
- Diuji: `test/settlements.spec.ts:288-436` (nominal tepat, replay, 4 release paralel → tepat satu
  menang), `test/payouts.spec.ts:656-905` (settle tepat sekali, gagal melepas hold tepat sekali,
  cancel tepat sekali, replay provider event tidak menggandakan), `test/payouts.spec.ts:1056-1111`.

### 2. Ledger

- Tidak ada penulisan `ledger_entries`/`ledger_transactions`/`wallet_accounts` langsung di
  `src/modules/settlements` maupun `src/modules/payouts` (grep → hanya `wallet.service.ts:391`).
- Setiap perpindahan = satu `postTransfer` seimbang (2 entri, amount sama) dengan pasangan akun yang
  benar: escrow→payable (release), payable→hold (hold), hold→clearing (settle), hold→payable
  (gagal/cancel) — `settlements.service.ts:221-249`, `payouts.service.ts:355-377,992-1019,1142-1169,
500-527`.
- Tiga namespace berbeda untuk tiga leg payout (`payouts.constants.ts:33-39`) plus
  `settlement_release` (`settlements.constants.ts:25-28`), menghindari `ledger_transactions_reference_uq`
  global; scope idempotensi juga berbeda per leg.
- Saldo tersedia/held = proyeksi `wallet_accounts.balance_minor` akun system, tidak pernah kolom
  (`settlements.service.ts:520-551`); ringkasan diturunkan dari tabel + proyeksi (`:456-514`).
- Diuji: identitas rekonsiliasi (1)(4)(5) di `test/settlements.spec.ts:712-776` dan (1)(2)(3) di
  `test/payouts.spec.ts:1156-1227`; assert sisi debit escrow memakai entri transaksi release itu
  sendiri (`test/settlements.spec.ts:309-321`), bukan saldo global yang dipakai bersama.

### 3. Saldo negatif

- `wallet_accounts_balance_nonnegative_check` hanya untuk `account_type='wallet'` (sesuai D18 Q6),
  jadi kompensasinya: `lockSystemAccount` (FOR UPDATE, `wallet.service.ts:155-190`) +
  perbandingan `BigInt` sebelum hold (`payouts.service.ts:345-354`) — bukan `Number`.
- Payable tidak bisa negatif: satu-satunya debit payable adalah hold, selalu didahului lock + cek.
  Hold tidak bisa negatif: setiap payout hanya punya satu leg terminal (CHECK), settle/release
  memakai `amount_minor` payout itu sendiri, dan hanya ada satu payout aktif per tenant sehingga
  saldo hold selalu ≥ amount payout yang aktif.
- Urutan lock konsisten "payable lebih dulu, lalu postTransfer (dua akun urut id)"
  (`settlements.service.ts:226-249`, `payouts.service.ts:345-377`), sehingga release dan payout satu
  tenant terserialisasi pada baris akun payable.
- Diuji: `test/payouts.spec.ts:583-654` (6 request paralel per ronde, payable/hold tidak pernah
  negatif, tepat 3 payout terdanai); `test/payouts.spec.ts:433-502` (amount melebihi saldo → 409).

### 4. Otorisasi

- Ketiga permission finansial hanya untuk owner terverifikasi: `TENANT_FINANCE_PERMISSIONS` +
  `owner_verified_at NOT NULL` (`access.service.ts:42-46,155-165`); staf kitchen/pickup selalu 403
  walau permission diberikan manual. `finance.read`/`bank_account.manage`/`payout.request` dipakai
  konsisten di controller/service.
- `tenantId` selalu dari path + sesi; tidak ada `tenant_id` dari body (DTO hanya
  `bankCode/accountNumber/accountHolderName/isDefault`, `bankAccountId/amountMinor`, `reason`).
- 404 vs 403 tidak membocorkan: non-anggota → 403 `Tenant access denied` untuk tenant mana pun
  (tidak membedakan tenant ada/tidak), rekening tenant lain → 404 lewat scope
  `where id=$1 and tenant_id=$2` (`payouts.service.ts:303-320`, `bank-accounts.service.ts:383-396`).
- Diuji: `test/settlements.spec.ts:696-710`, `test/bank-accounts.spec.ts` (kitchen/pickup/outsider
  403, 404 lintas tenant), `test/payouts.spec.ts:433-502`, `test/payouts-http.spec.ts`.

### 5. Rekening bank

- AES-256-GCM (`iv|tag|ciphertext`, base64) + HMAC-SHA256 berkunci untuk dedupe + masking
  `****1234` (`bank-account.crypto.ts:27-93`); kunci hilang/format salah → 503 fail closed
  (`:35-49`). HMAC (bukan hash polos) karena nomor berentropi rendah.
- Tidak ada ciphertext/hash/nomor lengkap di respons: `BankAccountView` hanya masked
  (`bank-accounts.service.ts:32-45,523-538`), audit hanya masked (`:169-182,245-258`), dan tidak ada
  `console`/logger yang mencetak nomor (`grep console. src/modules/payouts` kosong). Dekripsi hanya di
  processor, di luar transaksi/lock (`payouts.service.ts:767-781,1372-1399`).
- Perubahan rekening = baris baru + baris lama `disabled` (`:192-261`), tanpa UPDATE in-place dan
  tanpa delete; payout lama tetap memakai snapshot tujuan (`src/database/schema/payouts.ts:132-139`).
- Verifikasi 503 dan hanya jalur service-only (`bank-accounts.service.ts:314-332,340-380`), otorisasi
  dijalankan lebih dulu sehingga staf menerima 403, bukan 503.
- Diuji: `test/bank-accounts.spec.ts` 9/9 (termasuk "tidak ada plaintext di baris", "hash bukan
  SHA-256 polos", "tidak ada ciphertext/hash di list", replace = baris baru, 503 kunci hilang).

### 6. Kontrak lintas slice

- Method baru bersifat aditif dan tidak mengubah perilaku lama: `getOrderSettlementContext`
  (`orders.service.ts:1233-1283`, FOR UPDATE order + pembayaran sukses pertama),
  `hasOpenCasesForOrder` (`cases.service.ts:453-468`, FOR SHARE baris kasus terbuka),
  `lockSystemAccount` (`wallet.service.ts:155-190`, method baru).
- Hook tidak bisa menggagalkan aksi bisnis: `releaseQuietly` memakai savepoint
  `settlement_release_attempt` + rollback ke savepoint (`settlements.service.ts:361-411`) — wajib,
  karena error PostgreSQL membatalkan seluruh transaksi — plus try/catch lapis kedua di pemanggil
  (`pickup.service.ts:591-602`, `cases.service.ts:418-435`). Release yang gagal menulis audit
  `tenant.payable.release_failed`, yang ditunda menulis `tenant.payable.release_deferred`, dan
  kegagalan audit tidak menggagalkan apa pun (`:413-445`).
- Deadlock 40P01 terbukti terkendali: reviewer mereproduksi lock-order inversion (keputusan kasus
  memegang baris `cases` lalu `orders`; handover memegang `orders` lalu `cases` FOR SHARE) di kedua
  arah — PostgreSQL mendeteksi 40P01, savepoint memulihkan transaksi, dan **kedua sisi tetap COMMIT**
  (lihat §Test reviewer).
- `forwardRef` tidak membuat siklus tak terkendali: reviewer mem-boot `PickupModule + CasesModule +
SettlementsModule + PayoutsModule` dan semua injeksi resolve (`pickup.settlements`,
  `cases.settlements`, `settlements.cases`, `payouts.settlements` semuanya terisi).
- Regresi slice lama: `test/pickup.spec.ts` 16/16, `test/cases.spec.ts` 19/19,
  `test/orders.spec.ts` 16/16 lulus.

### 7. State machine

- Status settlement (`pending/available/paid_out/voided/reversed`) dan payout
  (`requested/processing/succeeded/failed/cancelled`) sama dengan CHECK skema; CHECK
  status↔timestamp dua arah (`settlements_status_timestamps_check`, `payouts_timestamps_check`) dan
  `payouts_ledger_legs_check` benar (diverifikasi lewat probe SQL: dua leg terminal dan
  `available` dengan `paid_out = amount` ditolak 23514).
- Transisi ilegal → 409: cancel setelah `processing` (`payouts.service.ts:490-499`, D18 Q9), cancel
  payout yang sudah `cancelled` idempoten, settlement tidak punya endpoint mutasi sama sekali.
- Satu payout aktif per tenant: partial unique + cek 409 `PAYOUT_ACTIVE_EXISTS`
  (`payouts.service.ts:331-340,401-406`).
- Hasil provider ambigu menahan dana, bukan dianggap gagal: attempt `unknown`, payout tetap
  `processing`, outbox `dead`, audit `tenant.payout.needs_assistance`
  (`:1244-1296,819-830,881-895`; diuji `test/payouts.spec.ts:841-903`).
- FIFO allocation konsisten: `paid_out_minor += take`, status `paid_out` hanya saat penuh, dan
  rollback + 409 internal bila settlement tidak menutup amount (`:1321-1370`; diuji
  `test/payouts.spec.ts:656-770,1009-1054`).

### 8. Validasi/error/OpenAPI

- DTO memakai class-validator dengan whitelist global `{whitelist, forbidNonWhitelisted, transform}`
  (`main.ts:34-38`); amount `^[1-9][0-9]{0,37}$`, UUID, cursor `^[A-Za-z0-9_-]{1,512}$`, enum status
  via `@IsIn`; service memvalidasi ulang untuk pemanggil non-HTTP.
- Kode error stabil dan terdokumentasi (`payouts.constants.ts:45-81`, `settlements.constants.ts:47-60`);
  status code tepat: 201 create, 200 cancel (`@HttpCode(200)`), 400/403/404/409/503; tidak ada pesan
  SQL/internal yang bocor ke klien.
- Swagger lengkap untuk 9 route payouts/bank-accounts dan 2 route finance (body, envelope
  `{data, meta}`, 400/401/403/404/409/503), termasuk 503 verifikasi dan 503 provider disabled.
- Diuji transport: `test/settlements-http.spec.ts` 5/5, `test/payouts-http.spec.ts` 9/9
  (401 semua route, masking, Idempotency-Key wajib, field asing ditolak 400 sebelum service,
  mapping 409/503/404/403).

### 9. Kualitas test (yang sudah ada)

- Semua test berjalan di PostgreSQL nyata (bukan mock service), memakai constraint, lock, dan
  trigger asli; tidak ada assert lemah berbasis saldo global — escrow diassert lewat entri transaksi
  release itu sendiri (`test/settlements.spec.ts:309-321`), clearing diassert sebagai delta
  (`test/payouts.spec.ts:719-724`).
- Jalur gagal luas: order belum completed, kasus terbuka, refund ada, tenant lain, release gagal
  (savepoint), penundaan aturan bisnis, amount melebihi saldo, rekening pending/tenant lain, mode
  disabled, provider failed/pending/transient, alokasi tidak menutup amount, replay provider event,
  snapshot tujuan setelah rekening diganti.
- Konkurensi nyata: 4 release paralel untuk satu order (`test/settlements.spec.ts:396-436`), 6
  request payout paralel per ronde (`test/payouts.spec.ts:583-654`), adapter dipanggil di luar lock
  dibuktikan dengan `FOR UPDATE NOWAIT` dari koneksi lain (`:965-1007`).
- Celah test: F1 (constraint 0009), F2 (handover→release), F5 (queue payout), F6 (boot modul).

### 10. Kepatuhan D18 (Q1–Q10)

| Q   | Keputusan                                             | Bukti implementasi                                                                                                                                               |
| --- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Akun payable/hold per tenant, clearing global         | `settlements.constants.ts:16-22`; saldo = proyeksi, bukan kolom (`settlements.service.ts:520-551`)                                                               |
| Q2  | Pemicu (a) handover + (b) kasus terminal; (c) ditunda | `pickup.service.ts:591-602`, `cases.service.ts:418-435`; tidak ada job penyapu (dicatat `docs/modules/settlements.md:92-93`)                                     |
| Q3  | Refund pasca-release ditolak (409)                    | `settlements.service.ts:192-199` menolak order yang punya baris refund; `cancelForRefundDecision` menolak `completed`                                            |
| Q4  | Verifikasi ditunda → 503, jalur service-only          | `bank-accounts.service.ts:314-332,340-380`; payout hanya ke `active + verified` (`payouts.service.ts:321-329`)                                                   |
| Q5  | `amount > 0` dan `<= available`; parsial diizinkan    | `normalizeMoney` (`payouts.service.ts:1720-1732`) + cek BigInt (`:345-354`); tidak ada min/max                                                                   |
| Q6  | Trigger DB ditunda; lock + BigInt + test wajib        | `wallet.service.ts:155-190`, `payouts.service.ts:345-354`, `test/payouts.spec.ts:583-654` (catatan: test serial per ronde)                                       |
| Q7  | Retensi/rekonsiliasi ditunda, identitas §4.4 diuji    | `test/settlements.spec.ts:712-776`, `test/payouts.spec.ts:1156-1227`                                                                                             |
| Q8  | Fee tidak dimodelkan                                  | Tidak ada kolom fee/net di `src/database/schema/payouts.ts`; total = gross                                                                                       |
| Q9  | Cancel saat `processing` ditolak; ambigu = `unknown`  | `payouts.service.ts:490-499`, `:819-830,1244-1296`                                                                                                               |
| Q10 | `lockSystemAccount` + env `PAYOUTS_PROVIDER_MODE`     | `wallet.service.ts:155-190` (method baru, perilaku lama utuh); `environment.ts:91`, `.env.example:37`; production selalu disabled (`payouts.service.ts:246-252`) |

## Test yang dijalankan reviewer + hasil

Infrastruktur: PostgreSQL 17 swarm `127.0.0.1:5544`, Redis `127.0.0.1:6381`, Node v24.22.2.
Sesuai D6, reviewer **tidak** menjalankan `npm test`, `npm run build`, atau `npm run test:integration`.

1. Database terpisah: `CREATE DATABASE antriin_review_sp`.
2. `DATABASE_URL=.../antriin_review_sp npm run db:migrate` → `migrations applied successfully` (0000–0009).
3. `npx tsc -p tsconfig.test.json --outDir .test-dist-review-sp` → exit 0, tanpa error.
4. `node --test` per file dengan `TEST_DATABASE_URL` / `REDIS_HOST=127.0.0.1` / `REDIS_PORT=6381` /
   `TEST_REDIS_PORT=6381` / `CORS_ORIGINS=http://localhost:3001` / `NODE_ENV=test`:

| Spec                            | Hasil       |
| ------------------------------- | ----------- |
| `test/settlements.spec.ts`      | 13/13 lulus |
| `test/settlements-http.spec.ts` | 5/5 lulus   |
| `test/payouts.spec.ts`          | 14/14 lulus |
| `test/payouts-http.spec.ts`     | 9/9 lulus   |
| `test/bank-accounts.spec.ts`    | 9/9 lulus   |
| **Total slice**                 | **50/50**   |
| `test/pickup.spec.ts` (regresi) | 16/16 lulus |
| `test/cases.spec.ts` (regresi)  | 19/19 lulus |
| `test/orders.spec.ts` (regresi) | 16/16 lulus |
| **Total dijalankan**            | **101/101** |

5. Probe SQL manual untuk constraint 0009 yang tidak tercakup test (dasar F1):

| Probe                                                                 | Hasil                                               |
| --------------------------------------------------------------------- | --------------------------------------------------- |
| payout `succeeded` diberi `release_ledger_transaction_id` (leg kedua) | ditolak 23514 `payouts_ledger_legs_check`           |
| payout `failed` diberi `settle_ledger_transaction_id`                 | ditolak 23514 `payouts_ledger_legs_check`           |
| settlement `available` dengan `paid_out_minor = amount_minor`         | ditolak 23514 `settlements_status_timestamps_check` |
| settlement `available` dengan `released_at = null`                    | ditolak 23514 `settlements_status_timestamps_check` |

6. Probe deadlock (skrip sementara di luar repo, memakai service hasil kompilasi + PostgreSQL nyata;
   order `completed` dengan satu kasus `under_review`):
   - A (jalur keputusan kasus): `BEGIN` → `SELECT cases ... FOR UPDATE` → `releaseAfterCaseDecision`.
   - B (jalur handover): `BEGIN` → `SELECT orders ... FOR UPDATE` → `releaseAfterHandover`.
   - Hasil arah 1: `Settlement release failed for order ... (case_decision) ... (code 40P01)`;
     log: A "transaction usable after release (probe ok=1)", A "COMMIT ok", B "COMMIT ok";
     audit: `tenant.payable.release_failed {source: case_decision, errorCode: 40P01}` +
     `tenant.payable.release_deferred {reason: open_case, source: handover}`; `settlements = 0`
     (tidak ada release ganda).
   - Hasil arah 2 (delay dibalik): korban menjadi sisi handover
     (`tenant.payable.release_failed {source: handover, errorCode: 40P01}`), kedua transaksi tetap
     `COMMIT`. Kesimpulan: 40P01 tidak lolos menjadi 500, dan tidak ada efek finansial ganda.
7. Probe DI (skrip sementara di luar repo): `Test.createTestingModule({ imports: [PickupModule,
CasesModule, SettlementsModule, PayoutsModule] })` → `pickupInjectedSettlements: true`,
   `casesInjectedSettlements: true`, `settlementsHasCases: true`, `payoutsHasSettlements: true`,
   `bankAccountsResolved: true` (siklus `forwardRef` resolve, dasar F6).
8. Pemeriksaan statis: tidak ada penulisan `ledger_entries`/`ledger_transactions`/`wallet_accounts`
   di `src/modules/settlements`/`src/modules/payouts`; tidak ada `console.*` di kedua modul; tidak ada
   route bentrok; `grep settlement test/pickup.spec.ts` kosong (dasar F2); tidak ada file test yang
   menyebut constraint 0009 (dasar F1).

Tidak diverifikasi reviewer: `npm test`/`npm run build`/`npm run test:integration` (klaim commit
353/353), boot API/worker nyata dengan BullMQ, dan perilaku dispatcher/processor payout terhadap Redis
nyata (hanya kode yang dibaca, dasar F5).

## Rekomendasi urutan perbaikan

1. F2 — test handover→release (dan handover yang tetap sukses saat release gagal); pertimbangkan
   menghapus `@Optional()` agar wiring rusak gagal keras.
2. F1 — pindahkan probe constraint 0009 ke `test/settlement-schema.spec.ts`/`schema-integrity.spec.ts`.
3. F6 + F5 — smoke test boot modul dan `test/payouts-queue.spec.ts`.
4. F3 — klasifikasikan `PAYOUT_PROVIDER_DISABLED` sebagai kegagalan permanen (hold kembali ke payable)
   atau dokumentasikan konsekuensi "dana tertahan".
5. F7 + F8 + F9 — perbaikan kontrak/pertahanan berlapis dan catatan penundaan pemantauan kampus yang
   dapat menyusul tanpa menahan integrasi.
6. F4 — FK komposit payout→rekening pada migrasi berikutnya (milik root) atau catat deviasinya.
