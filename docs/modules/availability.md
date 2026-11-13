# Modul Availability — pickup slots dan reservasi kapasitas

Status: **siap pakai untuk slice-nya** (bukan stub), diuji terhadap PostgreSQL 17 nyata.
Pemilik slice: availability-impl (task-2). Tabel milik slice ini: `pickup_slots`, `slot_reservations`.
Keputusan root yang mengikat: [D3, D5, D7, D8, D10, D12/D13, D15](../reviews/wave1-decisions.md).
Migrasi: 0000..0007 (FK `slot_reservations.order_id -> orders(id)`, kolom `consumed_at`/`updated_at` di `slot_reservations`).

## Kontrak internal untuk slice orders (wave 2) dan pickup

Semua mutasi reservasi menerima `PoolClient` milik pemanggil sehingga menyatu dengan
transaksi checkout/cancel/proposal, dan di-key oleh `orderId` (unique index
`slot_reservations_order_unique`) sehingga replay order yang sama idempoten.

```ts
assertBookableSlot(client, tenantId, slotId, lock: 'none' | 'share' | 'update' = 'none'): Promise<SlotQuoteContext>
reserveForCheckout(client, tenantId, slotId, expectedVersion, orderId): Promise<SlotReservation>
releaseReservation(client, tenantId, orderId): Promise<boolean>   // D13: scoped tenant
consumeReservation(client, tenantId, orderId): Promise<boolean>   // D13: scoped tenant
moveReservation(client, tenantId, orderId, newSlotId, expectedNewSlotVersion): Promise<SlotReservation>
```

### PRASYARAT FK (migrasi 0007) — WAJIB untuk checkout wave 2

`slot_reservations.order_id` punya FK ke `orders(id)` (`slot_reservations_order_fk`,
ON DELETE RESTRICT, sengaja TIDAK dilonggarkan). Baris `orders` **harus sudah ada**
(sebelum reserve, dalam transaksi yang sama). Urutan checkout yang benar:

`INSERT orders -> reserveForCheckout -> debit wallet -> snapshot/event/audit/outbox -> COMMIT`

Reserve dengan orderId yang tidak ada di `orders` gagal 23503 (500 bila tidak
ditangani pemanggil) — ini guard integritas, bukan bug.

### Mode lock assertBookableSlot (keputusan D15)

- `'none'` (DEFAULT; dipakai quote/read): plain SELECT **tanpa lock apa pun**.
  Hasilnya snapshot point-in-time untuk validasi, bukan otoritas kapasitas.
- `'share'`: FOR SHARE (tenant/campus + slot) — hanya untuk pemanggil yang
  menahan baris tanpa mutasi dan TIDAK akan upgrade ke UPDATE di transaksi sama.
- `'update'`: FOR UPDATE pada baris slot — **otoritas tunggal** mutasi kapasitas;
  hanya dipanggil internal oleh `reserveForCheckout`/`moveReservation`.

Alasan (bukti reviewer independen): pola lama quote `'share'` lalu reserve
FOR UPDATE pada baris sama = lock upgrade; dua transaksi paralel yang sama-sama
memegang SHARE lalu minta UPDATE saling tunggu -> deadlock 40P01 (8 checkout
paralel = 7 deadlock). Dengan quote `'none'`, 8 checkout paralel pada kapasitas 8
sukses semua tanpa deadlock (regresi ini diuji di test/availability-concurrency.spec.ts).

### Semantik version (keputusan D3 — WAJIB dibaca slice orders)

- `pickup_slots.version` adalah **versi konfigurasi** slot. Hanya aksi manajemen
  (`updateSlot`: kapasitas/status) yang menaikkannya.
- `reserve/release/consume/moveReservation` **tidak menaikkan version**. Mereka
  memutasi `reserved_count` di bawah `SELECT ... FOR UPDATE` + conditional update
  (`WHERE ... reserved_count < capacity`), dijaga CHECK DB
  `0 <= reserved_count <= capacity`.
- Akibatnya: banyak pembeli dengan quote `expectedVersion` yang sama dapat reserve
  paralel sampai kapasitas penuh; hanya perubahan konfigurasi (kapasitas turun/slot
  ditutup) yang membuat quote stale -> 409 `Pickup slot changed; request a new quote`.
- Alur checkout sesuai docs/HANDOFF.md + prasyarat FK 0007: cek replay order
  **sebelum** re-quote -> quoteHash -> INSERT `orders` -> `reserveForCheckout` ->
  debit wallet -> payment/snapshot/event/audit/outbox dalam satu transaksi.
  Reservasi tepat satu kursi per order.

### Semantik status reservasi

- `reserved`: satu kursi terpakai terhadap kapasitas. Reserve replay untuk
  order yang reservasinya sudah `released` -> 409 `Reservation for this order
was released; create a new checkout` (R2-11); sudah `consumed` -> 409
  `Reservation for this order was already consumed`; slot/tenant berbeda ->
  409 `Order already has another slot reservation`.
- `released`: kursi **dikembalikan** (batal/timeout sah); `released_at` wajib terisi
  (CHECK `slot_reservations_released_at_check`). Release ulang = no-op `false`
  (kapasitas tidak pernah dipulihkan dua kali); release order tak dikenal / tenant lain
  -> 404; release reservasi `consumed` -> 409.
- `consumed`: kursi **dipakai** (handover). Consume hanya dari `reserved`;
  replay consume = `false`; consume setelah release -> 409. Consume TIDAK
  mengembalikan kapasitas — kursi tetap terhitung terpakai pada slotnya.
  `consumed_at` di-stamp saat consume (CHECK dua arah 0007
  `slot_reservations_consumed_at_check` menolak consumed tanpa consumed_at dan
  sebaliknya).
- Semua mutasi `slot_reservations` men-set `updated_at = now()` eksplisit
  (kolom NOT NULL 0007; tidak ada trigger DB).
- Invariant rekonsiliasi FINAL (R1-18, disetujui root 12 Nov 2026):
  `reserved_count = COUNT(slot_reservations WHERE slot_id = X AND status IN ('reserved','consumed'))`.
  Test rekonsiliasi dijalankan terhadap PostgreSQL sesudah rangkaian operasi paralel
  (reserve massal, mixed release/consume/reserve, move paralel).
- `moveReservation`: release kursi lama + reserve kursi baru atomik dalam satu
  transaksi; kedua slot dikunci dengan urutan deterministik (ORDER BY id) untuk
  mencegah deadlock; slot tujuan wajib tenant yang sama (semua query di-scope
  `tenant_id` + composite FK `(tenant_id, slot_id)`); replay ke slot yang sama =
  no-op sukses; tujuan penuh/version stale/lintas tenant -> 409/404 tanpa menyentuh
  slot asal. Proposal acceptance (wave 2) memanggil method ini dalam transaksi
  keputusan proposal.

## Endpoint HTTP (prefix global /api/v1)

| Method & path                                         | Auth        | Permission               | Deskripsi                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | ----------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /tenants/:tenantId/availability`                 | publik      | —                        | Slot yang bisa dipesan pembeli: status `open`, `starts_at` masa depan, sisa kapasitas > 0, dalam jam operasional, untuk `date` tunggal ATAU rentang `from`..`to` (tanggal lokal tenant, inklusif, maks 31 hari). Respons memuat `timezone`, `range`, dan per slot `localDate`, `remainingCapacity`, `version` (untuk quote). Tenant paused/closed -> `slots: []` + status tenant. |
| `GET /tenants/:tenantId/availability/slots`           | sesi tenant | `tenant.capacity.manage` | Daftar manajemen: SEMUA slot (open/closed/penuh) pada rentang `from`..`to` lokal (maks 92 hari) dengan `capacity`, `reservedCount`, `remainingCapacity`, `status`, `version`, `updatedAt` (string mikrodetik, D7).                                                                                                                                                                |
| `POST /tenants/:tenantId/availability/slots`          | sesi tenant | `tenant.capacity.manage` | Buat slot: `startsAt`/`endsAt` ISO-8601 masa depan, `endsAt > startsAt`, `capacity >= 1`, window unik per tenant (409 bila duplikat), harus muat dalam jam operasional lokal hari yang sama (400 bila tidak). `reason` opsional (1..300) -> audit.                                                                                                                                |
| `PATCH /tenants/:tenantId/availability/slots/:slotId` | sesi tenant | `tenant.capacity.manage` | Ubah `capacity` dan/atau `status` (`open`\|`closed`) dengan `expectedVersion` (optimistic concurrency, D7.4). Version naik hanya di sini. Kapasitas di bawah `reservedCount` -> 409. Reopen slot yang sudah mulai -> 409. Reopen harus tetap muat jam operasional. `reason` **WAJIB** (1..300) untuk close dan penurunan kapasitas -> 400 bila kosong; opsional untuk reopen.     |

Semua query di-scope tenant; tenant harus non-archived dan kampusnya `active`
(404 selain itu). Status slot hanya berubah lewat aksi berizin di atas — input klien
tidak pernah dipercaya sebagai otoritas.

## Aturan bisnis

1. Kapasitas tidak pernah oversell: row lock + conditional update + CHECK DB.
   Uji konkurensi: N=12 reserve paralel pada kapasitas K=5 -> tepat 5 sukses, sisanya
   409 `full`, tanpa deadlock; `reserved_count` tidak pernah > kapasitas.
2. Idempotency per order: advisory lock `pg_advisory_xact_lock(hashtextextended(orderId,0))`
   - unique `order_id`; replay (bahkan paralel) mengembalikan reservasi yang sama
     tanpa menambah kursi; order sama dengan slot/tenant berbeda -> 409.
3. Satu kursi = satu order. Tidak ada reservasi multi-kursi.
4. Slot harus mulai di masa depan untuk reserve/quote (`starts_at > now`), tenant
   harus `open`, kampus `active`, slot `open`, dan window slot harus berada dalam
   satu hari lokal yang sama serta muat dalam jam operasional (override mengalahkan
   weekly).
5. Uang tidak disentuh slice ini; reservasi kapasitas digabung dengan debit wallet
   oleh slice orders dalam satu transaksi.
6. Baris `orders` harus sudah ada sebelum `reserveForCheckout` (FK 0007, lihat
   prasyarat di atas).

## Audit (keputusan root 12 Nov 2026)

Aksi manajemen yang berdampak pada komitmen pembeli menulis `audit_events` lewat
`AuditService.append` **dalam transaksi yang sama** (gagal tulis = rollback aksi):

| Aksi                        | action                                      | reason                                    | metadata                                       |
| --------------------------- | ------------------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| Buat slot                   | `tenant.availability.slot.created`          | opsional (default 'Pickup slot created')  | capacity, startsAt, endsAt                     |
| Tutup slot (open -> closed) | `tenant.availability.slot.closed`           | **WAJIB 1..300 char**                     | activeReservations                             |
| Buka kembali                | `tenant.availability.slot.reopened`         | opsional (default 'Pickup slot reopened') | capacity                                       |
| Turunkan kapasitas          | `tenant.availability.slot.capacity_reduced` | **WAJIB 1..300 char**                     | previousCapacity, capacity, activeReservations |

Actor selalu dari sesi (principal AuthGuard), tidak pernah dari body. Scope
`tenant`, target `pickup_slot`. Satu PATCH yang menutup sekaligus menurunkan
kapasitas menulis dua baris audit. Kenaikan kapasitas tidak diaudit (tidak
mengurangi hak pembeli). Reason divalidasi runtime (trim, 1..300) -> 400.

## Jam operasional (D5/D8)

Endpoint tulis/baca jam operasional dan status tenant BUKAN milik slice ini (sudah
dipindah ke slice tenant-campus sesuai keputusan root 12 Nov 2026). Validasi slot
(buat/reopen/reserve/quote) memakai SATU sumber kebenaran kontrak D8:
`TenantOperatingHoursService.resolveOperatingWindow(tenantId, localDate, client?)`
yang di-inject dari `TenantsModule` (diimpor `AvailabilityModule`; tenants tidak
mengimpor availability sehingga tidak ada circular dependency). Modul ini tidak
lagi menulis query sendiri ke `tenant_operating_hours`/`tenant_operating_hour_overrides`.
`client` transaksi pemanggil diteruskan apa adanya (D8: read-only tanpa lock
tambahan); serialisasi edit jadwal vs reservasi dilakukan oleh service jam
operasional (lock baris tenant) dan `lockTenantContext` di slice ini.

## Keputusan dan asumsi

- Timestamp respons (startsAt/endsAt/updatedAt/releasedAt di test) memakai
  `to_char(... AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` — string
  mikrodetik dari DB, tidak pernah re-serialize `new Date().toISOString()` (D7).
  Token konkurensi pickup_slots adalah `version`; tidak ada `expectedUpdatedAt`.
- `release`/`consume` mengembalikan boolean: `true` = transisi dilakukan,
  `false` = replay idempotent; 404 untuk order/tenant tak dikenal, 409 untuk
  transisi ilegal. Pemanggil (orders worker) dapat retry dengan aman.
- Batas rentang: pembeli 31 hari, staf 92 hari; di luar itu 400. Listing pembeli
  (R2-05): kandidat diambil hingga LIMIT 5000 per rentang, filter jam operasional
  di-cache per tanggal lokal (satu panggilan D8 per tanggal, bukan per slot), lalu
  respons dipotong di 200 slot — filter tidak bisa menyebabkan under-report di
  bawah cap. Daftar staf LIMIT 500. Pagination cursor belum dibutuhkan pilot.
- Pemetaan error DB -> kontrak HTTP (R2-02 + keputusan root 12 Nov 2026: setiap
  `ConflictException` hasil pemetaan WAJIB membawa `code` kontrak stabil di body,
  status HTTP tetap 409). Kode ini yang dipakai slice orders untuk memicu retry
  dan oleh test untuk assertion:

  | SQLSTATE                               | Kondisi                                                                | HTTP | `code` body                  |
  | -------------------------------------- | ---------------------------------------------------------------------- | ---- | ---------------------------- |
  | 23505 `pickup_slots_tenant_window_uq`  | window slot duplikat                                                   | 409  | `SLOT_WINDOW_CONFLICT`       |
  | 23505 `slot_reservations_order_unique` | race reserve order sama                                                | 409  | `RESERVATION_IN_PROGRESS`    |
  | 23514                                  | CHECK capacity/window/released_at/consumed_at                          | 409  | `CHECK_CONSTRAINT_VIOLATION` |
  | 23503                                  | FK `slot_reservations_order_fk` (orders belum ada) / composite slot FK | 409  | `REFERENCE_CONFLICT`         |
  | 40P01 / 40001                          | deadlock / serialization failure (retryable)                           | 409  | `DATABASE_DEADLOCK`          |

  Error DB yang dikenal tidak pernah bocor sebagai 500; error lain (termasuk
  HttpException) diteruskan apa adanya.

- Batas kapasitas 1..2.147.483.647 divalidasi di SERVICE juga (R2-06), bukan hanya
  DTO, sehingga pemanggil non-HTTP tidak memicu 22003 -> 500.
- Reopen slot yang `starts_at`-nya sudah lewat ditolak (409 `already started`).
- Permission manajemen slot: `tenant.capacity.manage` (D10) — staf kitchen bisa
  bila diberi grant eksplisit; staf pickup tidak.

## Batasan / pekerjaan tersisa

- Migrasi 0007 SUDAH diterapkan dan diuji di slice ini: mutasi `slot_reservations`
  men-set `updated_at = now()` eksplisit; consume men-set `consumed_at = now()`
  (CHECK dua arah diverifikasi test, termasuk penolakan 23514 saat men-NULL-kan
  `released_at`/`consumed_at` langsung di DB).
- Belum ada `expires_at`/TTL hold reservasi (keputusan produk "masa tahan slot"
  §3.3 masih terbuka, R1-13); release saat ini dipanggil eksplisit oleh alur
  cancel/proposal, bukan oleh job expiry.
- Menutup slot yang masih punya reservasi aktif TIDAK melepaskan/memindahkan
  reservasi tersebut (keputusan manusia lewat kasus/proposal sesuai PILOT-POLICY).
  Outbox/notifikasi untuk slot ditutup TIDAK diwajibkan saat ini (keputusan root
  12 Nov 2026 — jangan menambah event type sendiri); bila produk nanti
  menginginkannya, butuh arahan root.
- Test pada level service terhadap PostgreSQL nyata (pola wallet-ledger.spec)
  plus kontrak HTTP tanpa DB di test/availability-http.spec.ts (pola
  catalog-http.spec: module test + override guard + ValidationPipe global;
  mencakup 401/403/400/404/409, DTO edge validation, koersi transform, dan
  principal dari sesi). Verifikasi boot DI (AppModule resolve +
  /api/v1/health/ready 200) dilakukan via build sandbox .test-dist-availability*.
- Constructor `AvailabilityService` kini 4 dependensi: DatabaseService,
  AccessService, TenantOperatingHoursService (D8), AuditService (audit manajemen).
  Konsumen yang meng-instantiate manual (mis. test slice lain) perlu menyesuaikan
  (sudah dikoordinasikan lewat root; test catalog sudah diperbaiki catalog-impl).
