# Keputusan root — wave 1 (12 November 2026)

Catatan hidup milik root untuk seluruh agent wave 1/2. Keputusan di sini mengikat; perubahan harus lewat root. Bukan dokumen produk: aturan produk tetap di [../PILOT-POLICY.md](../PILOT-POLICY.md) dan [../REQUIREMENTS-API.md](../REQUIREMENTS-API.md).

## D1 — Schema katalog/order/payment diekspor dan dimigrasikan

- `src/database/schema/index.ts` mengekspor `catalog`, `orders`, `payments`.
- Migrasi baru: `drizzle/0006_fancy_white_queen.sql`. Draft awal `0006_dear_sasquatch.sql` GAGAL apply di PostgreSQL bersih (`there is no unique constraint matching given keys for referenced table "menu_categories"`) karena composite FK `(tenant_id, x_id)` menunjuk unique INDEX yang dibuat setelah FK. File gagal itu belum pernah diterapkan di lingkungan mana pun, jadi dihapus dan di-generate ulang.
- Perbaikan: `menu_categories`, `menu_items`, `menu_option_groups`, `pickup_slots` memakai `CONSTRAINT ... UNIQUE (tenant_id, id)` inline (bukan `uniqueIndex`).
- Bukti: 0000..0006 apply bersih di PostgreSQL 17 (39 tabel, 54 FK); `npm run test:integration` 44/44 lulus pada commit `3c72799`.
- Migrasi 0000..0005 tidak boleh diubah. Schema baru = migrasi baru.

## D2 — Konfigurasi pilot ditambahkan root

`src/config/environment.ts` + `.env.example`: `ORDER_PROPOSAL_TTL_SECONDS` (600, 60..3600), `ORDER_PREPARATION_LEAD_SECONDS` (900, 0..7200), `PICKUP_CREDENTIAL_TTL_SECONDS` (7200, 300..86400), `PAYMENTS_PROVIDER_MODE` (`disabled|sandbox`, production hanya `disabled`), `PAYMENTS_TOPUP_MIN_MINOR` (1000), `PAYMENTS_TOPUP_MAX_MINOR` (2000000, min ref), `PAYMENTS_SANDBOX_WEBHOOK_SECRET` (>=32 char, wajib saat sandbox). `src/main.ts` mengaktifkan `rawBody: true` untuk HMAC webhook. Agent lain tidak boleh mengedit file-file ini; permintaan env baru lewat root.

## D3 — Semantik `pickup_slots.version`

- `version` = versi KONFIGURASI slot. Hanya aksi manajemen (ubah capacity/status/window) yang menaikkannya.
- `reserve/release/consume/moveReservation` TIDAK menaikkan version; mereka memakai `SELECT ... FOR UPDATE` + conditional update (`reserved_count < capacity`) + CHECK constraint DB.
- `expectedVersion` dari quote tetap diverifikasi; stale sesudah perubahan kapasitas/status -> 409 "perlu quote baru". Reservasi paralel dengan version yang sama harus bisa sukses sampai kapasitas penuh.
- Alasan: semantik WIP (version naik tiap reservasi) membuat uji konkurensi "N reserve paralel pada kapasitas K -> tepat K sukses" mustahil.
- Signature kontrak (docs/HANDOFF.md) tidak berubah: `reserveForCheckout(client, tenantId, slotId, expectedVersion, orderId)`, `moveReservation(client, tenantId, orderId, newSlotId, expectedNewSlotVersion)`, `release/consume(client, tenantId, orderId)`. Slice orders wave 2 wajib membaca keputusan ini.

## D4 — Kepemilikan tabel & endpoint wave 1

| Tabel                                                                                                                          | Pemilik slice               | Modul                                         |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | --------------------------------------------- |
| `menu_categories`, `menu_items`, `menu_option_groups`, `menu_option_choices`                                                   | catalog-impl (task-1)       | `src/modules/catalog`                         |
| `pickup_slots`, `slot_reservations`                                                                                            | availability-impl (task-2)  | `src/modules/availability`                    |
| `campuses`, `tenants`, `tenant_memberships`, `campus_memberships`, `tenant_operating_hours`, `tenant_operating_hour_overrides` | tenant-campus-impl (task-3) | `src/modules/tenants`, `src/modules/campuses` |
| `topup_intents`, `payment_request_outbox`, `payment_provider_events`                                                           | payments-impl (task-4)      | `src/modules/payments`                        |
| `orders`, `order_*`, `schedule_proposals`, `pickup_credentials`                                                                | wave 2 (belum dimiliki)     | `src/modules/orders`, `src/modules/pickup`    |

Aturan: satu tabel hanya punya satu penulis. Slice lain boleh MEMBACA tabel slice lain dengan query read-only sendiri, tanpa mengimpor modulnya dan tanpa mengedit file pemilik.

## D5 — Endpoint jam operasional pindah ke tenants

WIP availability memuat `PUT /tenants/:id/operating-hours` (+ overrides) dan `PATCH /tenants/:id/availability/status` yang menulis tabel milik task-3. Keputusan: endpoint itu DIHAPUS dari availability dan diimplementasikan di `src/modules/tenants`. Availability hanya membaca jam operasional (read-only) untuk menolak slot di luar jam buka. Tidak boleh ada dua pemilik route/tabel yang sama.

## D6 — Konvensi kerja paralel (semua agent)

- Node 24: `export PATH=/Users/macbook/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH`. Docker CLI: `/Applications/Docker.app/Contents/Resources/bin`.
- Infra swarm root (jangan bikin/hapus container): PostgreSQL 17 `127.0.0.1:5544` (user `antriin_swarm`, db per slice), Redis `127.0.0.1:6381`.
- Dilarang `npm test`, `npm run build`, `npm run test:integration` (keluaran bersama / kontainer sendiri). Pakai `npx tsc -p tsconfig.test.json --outDir .test-dist-<slice>` lalu `node --test .test-dist-<slice>/test/<file>.spec.js`. `.gitignore` sudah mengabaikan `.test-dist*/`.
- Error typecheck di luar file milik sendiri adalah noise dari kerja paralel; jangan "memperbaiki" file agent lain.
- Tanpa git commit/push oleh agent; root yang meng-commit setelah review independen.
- Tanpa nested delegation (agent tidak men-spawn agent lain).

## D7 — Presisi timestamp untuk optimistic concurrency (WAJIB semua slice)

Bug pola WIP: expectedUpdatedAt dikirim sebagai Date.toISOString() lalu dibandingkan updated_at = $n::timestamptz. PostgreSQL now() berpresisi MIKRODETIK, JS Date hanya MILIDETIK, sehingga equality tidak pernah match. Bukti di antriin_tenantcampus: nilai DB 2026-11-12T06:58:04.970761Z vs ISO ...970Z -> 0 baris cocok; string mikrodetik -> 1 baris.

Aturan:

1. Respons mutasi mengembalikan updatedAt sebagai string mikrodetik yang dihasilkan DB: to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"').
2. Klien mengirim balik string itu PERSIS; server membandingkan sebagai parameter ::timestamptz (atau teks), mismatch -> 409.
3. Dilarang re-serialize lewat new Date(...) / toISOString() pada nilai yang dipakai untuk perbandingan.
4. Bila tabel punya kolom version (menu_items, menu_option_groups, menu_option_choices, pickup_slots, schedule_proposals), utamakan version untuk optimistic concurrency; expectedUpdatedAt hanya penjaga tambahan.
5. Dedupe keuangan tetap lewat unique constraint (idempotency_key, provider_reference, provider+event_id), bukan timestamp.

## D8 — Kontrak baca jam operasional (sumber tunggal)

TenantsModule meng-export TenantOperatingHoursService.resolveOperatingWindow(tenantId, localDate 'YYYY-MM-DD', client?) -> { tenantId, timezone, localDate, weekday 0..6, isOpen, opensAt 'HH:MM:SS'|null, closesAt|null, source 'override'|'weekly'|'none' }. Override mengalahkan weekly; tenant archived / kampus nonaktif -> 404; aman dipanggil dengan PoolClient transaksi pemanggil tanpa lock tambahan.

- Slice availability wajib memakainya untuk validasi slot (import TenantsModule), tidak menulis query sendiri ke tenant_operating_hours.
- Wave 2 (orders/checkout) memakai kontrak yang sama untuk menilai slot terhadap jam buka.
- Modul tenants tidak boleh mengimpor availability (hindari circular dependency).

## D9 — Provisioning owner tenant dan campus admin

- Owner tenant: POST /v1/campuses/:campusId/tenants/:tenantId/owner, guard campus.access.manage, HANYA bootstrap owner pertama (409 bila sudah ada owner aktif), actor != subject, subject user aktif, advisory lock sama dengan AccessService.grantTenantMembership, menulis tenant_memberships(role=owner, owner_verified_at=now()) + access_audit_events(grant) + audit_events.
- Campus admin: TIDAK ada endpoint publik (sesuai docs/ACCESS.md). CampusProvisioningService.provisionCampusAdmin({actor userId|service, campusId, subjectUserId, permissions, reason}) service-only untuk bootstrap terkontrol; actor user wajib punya campus.access.manage.
- Keterbatasan skema yang diterima sementara: access_audit_events.actor_user_id dan membership_id NOT NULL, sehingga bootstrap dengan actor service tidak menulis access_audit_events. Kewajiban wave ini: bootstrap service-actor menulis audit_events (actor_service, scope campus, action + reason + target jelas). Keputusan terbuka root: apakah access_audit_events perlu kolom actor_service + check XOR pada migrasi berikutnya (menyentuh slice KAN-24 yang sudah diterima -> perlu review terpisah). Agent tidak boleh membuat migrasi.

## D10 — Pemetaan permission (inventaris resmi: src/modules/access/access.service.ts)

| Aksi                                       | Permission                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| CRUD kategori/item/opsi menu               | tenant.menu.manage                                                         |
| Manajemen slot, kapasitas, jam operasional | tenant.capacity.manage                                                     |
| Pause/status tenant oleh staf tenant       | tenant.orders.pause                                                        |
| CRUD/arsip tenant oleh campus admin        | campus.tenants.manage                                                      |
| Grant/revoke akses, bootstrap owner tenant | campus.access.manage                                                       |
| Top-up wallet (buyer)                      | tidak butuh permission tenant; cukup sesi buyer sah + kepemilikan resource |

Agent tidak boleh menambah nama permission baru; usulan lewat root (file access milik root).

## D11 — Wiring queue payments (milik root, menunggu laporan)

Pola yang akan root pakai: konstanta queue + BullModule.registerQueue di src/jobs/jobs.module.ts, processor/dispatcher sebagai provider di src/worker.module.ts bersama import modul feature (mengikuti OutboxDispatcher/OutboxProcessor; default attempts 3, backoff exponential). payments-impl melaporkan nama queue, nama class, modul yang perlu diimpor, dan titik enqueue; root yang memasang lalu memverifikasi boot API + worker.

## D12 — Jawaban root atas 10 pertanyaan review schema (docs/reviews/schema-wave1.md §5)

Semua perbaikan schema wave 1 masuk SATU migrasi baru **0007** (0006 sudah di-commit di 3c72799 dan sudah diterapkan di beberapa DB -> tidak boleh diedit). Owner file schema: root; implementasi didelegasikan ke agent schema-fixer (task-6) dengan aturan ADITIF SAJA: tidak ada rename, tidak ada perubahan tipe, tidak ada DROP; kolom baru wajib nullable atau punya default aman supaya kode wave 1 yang sedang berjalan tidak rusak.

1. **Rumus harga DIKUNCI (prasyarat R1-07).** unit_price_minor = base_unit_price_minor + SUM(price_delta_minor opsi terpilih per unit); line_total_minor = unit_price_minor * quantity (CHECK per baris di order_items); subtotal_minor = SUM(line_total_minor) lintas baris -> ditegakkan transaksional di service + test PostgreSQL rekonsiliasi; pilot tanpa fee/pajak/diskon -> CHECK orders.total_minor = orders.subtotal_minor; order_payments.amount_minor = orders.total_minor ditegakkan dalam transaksi checkout + test (cross-table tidak bisa CHECK).
2. **Strategi:** satu migrasi 0007 untuk R1-01..R1-08 + minor yang disetujui di bawah; verifikasi wajib: apply bersih di PostgreSQL 17 baru, 44 test baseline tetap lulus, plus test integritas schema baru.
3. **Promosi UNIQUE disetujui:** orders UNIQUE(tenant_id, id) dan UNIQUE(buyer_id, id); wallet_accounts UNIQUE(owner_user_id, id) (foundation, aditif, NULL owner tetap aman karena NULL distinct); pickup_credentials UNIQUE(order_id, id). tenants UNIQUE(campus_id, id) TIDAK perlu (lihat jawaban 4).
4. **campus_id / order_number / waktu transisi:** orders.campus_id TIDAK didenormalisasi -> derived by join tenants.campus_id (tanpa risiko drift; cukup untuk skala pilot; dicatat di docs). order_number DITAMBAHKAN (varchar 32, NOT NULL, UNIQUE) dan generatornya menjadi tugas wave 2 (harus collision-safe: retry saat unique violation). Kolom waktu DITAMBAHKAN: paid_at, cancelled_at, declined_at (nullable) + CHECK temporal status<->timestamp dan monotonicity created <= confirmed <= preparing <= ready <= completed.
5. **Order total 0 DITOLAK di pilot:** CHECK subtotal_minor > 0 dan total_minor > 0. Alasan: order hanya lahir dari pembayaran wallet sukses (PILOT-POLICY) dan order_payments.amount_minor > 0; jalur free-order di luar scope pilot. Dicatat sebagai keputusan root yang terlihat pengguna; bila produk menginginkan order gratis, itu keputusan produk terpisah.
6. **Masa tahan reservasi:** TIDAK ada expires_at di slot_reservations untuk pilot. Checkout bersifat atomik (debit + reserve dalam satu transaksi) sehingga tidak ada hold tanpa pembayaran; release hanya lewat pembatalan/refund atau consume saat handover. Dicatat; bila kelak ada cart/hold, tambah migrasi baru.
7. **order_events:** enum diperluas di 0007 menjadi: order.created, order.status_changed, order.cancelled, order.declined, schedule_proposal.created, schedule_proposal.decided, pickup_credential.issued, pickup_credential.revoked. Kolom request_id (uuid, nullable, FK ke order_request_idempotency.id) + indeks ditambahkan untuk korelasi idempotency.
8. **Delta harga opsi >= 0 DIPERTAHANKAN** (tidak ada produk opsi diskon di pilot; katalog dan snapshot konsisten).
9. **Jam operasional:** jendela lintas tengah malam TETAP dilarang di pilot (opens_at < closes_at); keterbatasan dicantumkan di docs modul tenants. Konvensi weekday DIBAKUKAN: **0 = Minggu ... 6 = Sabtu** (mengikuti JS Date.getDay()), dihitung dalam timezone tenant/kampus; wajib ditulis di komentar schema, docs modul, dan kontrak resolveOperatingWindow. Kedua tabel operating hours mendapat PRIMARY KEY composite sebagai CONSTRAINT ((tenant_id, weekday) dan (tenant_id, local_date)) + kolom created_at default now().
10. **Kode pickup:** hash (code_hash) adalah jalur validasi; code_ciphertext hanya bila produk butuh menampilkan ulang. Kunci memakai AUTH_ENCRYPTION_KEY yang sudah ada; dilarang mencetak plaintext/ciphertext di log; jalur pemulihan = rotasi credential (credential lama revoked, satu credential aktif per order sudah dijaga partial unique). Rencana rotasi key/backup menjadi pekerjaan operasional tersendiri, bukan wave ini.

### Minor yang ikut dikerjakan di 0007 (aditif)

- R1-11: menu_items.image_ref varchar(500) NULL, menu_items.archived_at timestamptz NULL (+ CHECK archived_at terisi hanya saat status='archived').
- R1-12: order_items.notes varchar(500) NOT NULL DEFAULT '' (snapshot catatan per item).
- R1-13: slot_reservations.consumed_at timestamptz NULL, slot_reservations.updated_at timestamptz NOT NULL DEFAULT now() (di-set eksplisit oleh aplikasi), CHECK status<->timestamp untuk consumed (pola released_at yang sudah benar).
- R1-14: pickup_credentials CHECK expires_at > created_at dan (consumed_at is null OR revoked_at is null). Attempt counter tetap app-level (Redis/rate limit), didokumentasikan.
- R1-16: order_request_idempotency.expires_at timestamptz NULL + indeks; job cleanup retensi menjadi pekerjaan wave operasional (dicatat, belum diimplementasi).
- R1-22: batas quantity DB dilonggarkan menjadi 1..999 (batas longgar di DB); batas operasional pilot dijaga di DTO (1..200) sehingga produk dapat mengubahnya tanpa migrasi. Dicatat untuk konfirmasi produk.

### Minor yang TIDAK dikerjakan sekarang (keputusan sadar)

- R1-09 campus_id denormalisasi (derived by join), R1-18 rekonsiliasi reserved_count (wajib atomic conditional update + test rekonsiliasi counter vs COUNT(reservations) di slice availability; job audit berkala = wave operasional), R1-19 hard delete katalog (kebijakan service: tolak hard delete, pakai status='archived'), R1-21 order_payments succeeded-only (satu payment sukses per order, wallet-only pilot; attempt/provider lain = tabel baru kelak).

## D13 — Kontrak publik slice availability (dipakai wave 2 orders/pickup)

Laporan availability-impl diterima root; signature final yang HARUS dipakai slice orders/pickup wave 2 (perubahan nama terhadap docs/HANDOFF.md dicatat di sini sebagai sumber terbaru):

- reserveForCheckout(client, tenantId, slotId, expectedVersion, orderId) — sesuai HANDOFF.
- moveReservation(client, tenantId, orderId, newSlotId, expectedNewSlotVersion) — sesuai HANDOFF.
- releaseReservation(client, tenantId, orderId) — SEBELUMNYA ditulis release(...); kini tenant-scoped, reservasi tenant lain -> 404.
- consumeReservation(client, tenantId, orderId) — SEBELUMNYA consume(...); kini tenant-scoped.
- assertBookableSlot(...) — tetap sesuai HANDOFF.

Aturan terkait yang mengikat wave 2:

1. Semua method menerima PoolClient milik transaksi pemanggil (checkout: quote -> reserve -> debit -> order/payment/snapshot/event/audit/outbox dalam SATU transaksi).
2. pickup_slots.version adalah token konkurensi konfigurasi (D3); expectedVersion dari quote -> 409 bila slot diubah/ditutup sesudah quote.
3. Timestamp respons berupa string mikrodetik dari DB (D7); jangan parse ke Date untuk perbandingan.
4. Validasi jam operasional availability saat ini memakai method privat resolveOperatingWindow(tenantId, localDate, client?) dengan bentuk return persis D8; setelah tenant-campus-impl menerbitkan TenantOperatingHoursService, body method itu didelegasikan (call site tidak berubah). Root yang memastikan tidak ada duplikasi logika.
5. Sesudah migrasi 0007 apply: slot_reservations.updated_at di-set eksplisit pada tiap UPDATE dan consumed_at=now() saat consume; wajib ada test rekonsiliasi reserved_count vs COUNT(slot_reservations status='reserved') (R1-18).

## D14 — Keputusan slice katalog (task-1)

1. CHECK menu_items.archived_at BIDIRECTIONAL di 0007: (status='archived' AND archived_at IS NOT NULL) OR (status<>'archived' AND archived_at IS NULL). Konsekuensi wajib: jalur reaktivasi item harus mengosongkan archived_at (set NULL) dalam transaksi yang sama.
2. Arsip kategori TIDAK mengarsipkan item; penyembunyian lewat join kategori status='active'. Quote dan discovery pembeli wajib menolak/menyembunyikan item aktif yang kategorinya terarsip (ada test).
3. Perubahan deskripsi ikut menaikkan version item (konservatif untuk snapshot order).
4. Audit WAJIB (AuditService.append dalam transaksi yang sama) untuk perubahan berdampak uang/status: harga item (tenant.menu.item.price_changed), archive/reaktivasi item atau kategori, perubahan status sold_out. reason dari DTO (bounded), actor dari sesi. Tidak perlu audit untuk create/update nama/deskripsi/gambar biasa.
5. Outbox/notifikasi perubahan menu DITUNDA (keputusan produk terbuka; DOMAIN_EVENT_TYPES belum punya event menu). Agent tidak boleh menambah event type sendiri.
6. Batas quantity: DTO pilot 1..200 (konstanta MAX_QUOTE_LINE_QUANTITY), DB 1..999 setelah 0007.
7. quoteHash kanonik atas payload ternormalisasi: opsi diurut (groupId, choiceId), baris item diurut menuItemId khusus untuk hash (urutan respons mengikuti request). Quote bersifat read-only: tidak mengubah reserved_count maupun version slot.
8. Uang di DTO/API: string desimal dengan pola ^(0|[1-9][0-9]{0,37})$; total 0 ditolak 400 (D12 butir 5).

- Kesenjangan entitas refund/cases/settlement/payout/review/risk = wave berikutnya sesuai roadmap, bukan bug wave 1.

## D15 — Urutan checkout & penguncian slot (BLOCKER ditemukan reviewer, 12 Nov)

Reviewer independen membuktikan dua kegagalan nyata pada rancangan checkout:

1. `slot_reservations.order_id` kini punya FK ke `orders(id)` (0007). Urutan lama (reserve dengan `orderId` yang belum ada) gagal 23503. **Keputusan root:** baris `orders` WAJIB di-INSERT lebih dulu di dalam transaksi yang sama, baru reserve. Urutan resmi checkout: quote (server recompute) -> INSERT orders (status `paid_awaiting_tenant`, total sudah diketahui) -> INSERT order_items/order_item_options -> reserveForCheckout(orderId) -> debit wallet -> INSERT order_payments -> order_events + audit + outbox. Semua tetap satu transaksi; kegagalan di langkah mana pun me-rollback seluruhnya. Schema TIDAK dilonggarkan (tidak ada FK deferred, tidak ada kolom nullable baru).
2. Deadlock lock-upgrade: `CatalogService.quote` memakai `assertBookableSlot(..., 'share')` (FOR SHARE) lalu `reserveForCheckout` memakai FOR UPDATE pada baris yang sama dalam transaksi yang sama. Dua checkout paralel saling menunggu upgrade -> PostgreSQL 40P01 (terbukti 7/8 deadlock). **Keputusan root:** quote TIDAK boleh mengunci baris slot. `assertBookableSlot` mendapat mode `none` (plain SELECT, tanpa FOR SHARE/FOR UPDATE) yang dipakai quote; reserve tetap `update` (FOR UPDATE) dan tetap menjadi satu-satunya otoritas validasi slot. Quote bersifat advisory, reserve bersifat authoritative.
3. Pertahanan tambahan: checkout menangkap SQLSTATE 40P01 (deadlock) dan 40001 (serialization failure), mengulang transaksi paling banyak satu kali, dan memetakan kegagalan ulang ke 409 CONFLICT (bukan 500). Tidak boleh ada retry yang menggandakan efek finansial: retry hanya boleh membungkus transaksi yang belum commit.
4. Dokumentasi wajib diperbarui: `docs/modules/availability.md` menyebut prasyarat "baris order harus ada sebelum reserve" dan semantik mode `none`; `docs/modules/orders.md` memuat urutan checkout resmi; `docs/HANDOFF.md` diperbarui root saat integrasi.

## D16 — Akun ledger, permission, dan kontrak pickup (wave 2a, diterima root)

1. Akun system ledger baru **`orders.payment.escrow`** (dana pembayaran ditahan terpisah dari payable tenant; BUKAN akun sandbox top-up). Dicatat di sini sebagai keputusan resmi; nama dan alasannya wajib disebut di `docs/modules/orders.md`. Akun system tidak boleh punya saldo negatif kecuali dinyatakan lain oleh constraint yang sudah ada.
2. Permission transisi status order: `confirmed`/`declined` = `tenant.orders.accept`; `preparing` = `tenant.orders.prepare`; `ready_for_pickup` = `tenant.orders.prepare` ATAU `tenant.orders.accept` (dicek berurutan); `completed` (handover) = `tenant.orders.handover`. Staf pickup tidak mendapat akses finance/bank/payout.
3. Checkout menahan lock `FOR UPDATE` pada baris slot SEBELUM quote (`assertBookableSlot(..., 'update')`) sehingga tidak ada jalur lock-upgrade; quote sendiri memakai mode `none` (tanpa lock baris slot). Keduanya dipertahankan: pre-lock menjamin urutan deterministik, quote tetap advisory.
4. Retry deadlock: maksimal SATU retry untuk SQLSTATE 40P01/40001, kegagalan kedua -> `409 CHECKOUT_RETRY_CONFLICT` (bukan 500). Retry hanya membungkus transaksi yang belum commit.
5. Idempotency HTTP: header `Idempotency-Key` WAJIB pada `POST /v1/orders` (400 `IDEMPOTENCY_KEY_REQUIRED` bila tidak ada, 400 `IDEMPOTENCY_KEY_INVALID` bila bentuknya tidak sah: 8..200 karakter A-Z a-z 0-9 . _ :). Service memvalidasi ulang untuk pemanggil non-HTTP.
6. Kontrak pickup (stabil, dipakai slice pickup):
   - `OrdersService.getOrderForHandover(client, tenantId, orderId)` -> `{ orderId, tenantId, buyerId, status, pickupSlotId, totalMinor, currency }`
   - `OrdersService.markHandedOver(client, tenantId, orderId, actorUserId)` -> `void` (validasi status `ready_for_pickup`, set `completed`+`completed_at`, `consumeReservation`, tulis `order_events` + audit; replay = no-op).
     Keduanya menerima `PoolClient` transaksi pemanggil; permission handover diperiksa pemanggil (`tenant.orders.handover`).
7. Order number: `AN-YYYYMMDD-XXXXXX` (Crockford base32, 6 karakter), collision-safe dengan retry pada 23505; `orders.order_number` masih nullable di DB dan akan dibuat NOT NULL setelah backfill (migrasi berikutnya).
