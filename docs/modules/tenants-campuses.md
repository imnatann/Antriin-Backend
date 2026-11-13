# Modul Tenants & Campuses

Slice `tenant-campus` (task-3, KAN-24/KAN-18). Pemilik tunggal tabel `tenants`, `campuses`, `tenant_operating_hours`, dan `tenant_operating_hour_overrides` untuk jalur tulis; membership dibaca dan ditulis hanya lewat jalur provisioning terkontrol di bawah. Status implementasi: **siap pakai untuk pilot** (bukan stub) dengan batasan yang tercatat di bagian akhir.

Semua otorisasi ditegakkan server-side lewat `AccessService.requireTenant` / `requireCampus` dengan `PoolClient` transaksi untuk aksi kritis (revoke/mutasi terserialisasi). Semua mutasi menyetel `updated_at` secara eksplisit (tidak ada trigger DB). Semua aksi pengelola (create/update/status/archive/provisioning/jam operasional) menulis `audit_events` immutable lewat `AuditService.append` dalam transaksi yang sama; provisioning membership juga menulis `access_audit_events`.

## Konvensi lintas slice

### D7 — `updatedAt` / `expectedUpdatedAt` presisi mikrodetik

`now()` PostgreSQL menyimpan mikrodetik; `Date.toISOString()` JavaScript hanya milidetik, sehingga round-trip lewat JS Date memutus equality optimistic-concurrency (terverifikasi: nilai DB `...04.970761Z` vs JS `...04.970Z` → equality gagal). Karena itu:

- Respons mutasi merender `updatedAt` langsung dari PostgreSQL: `to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` (contoh `2026-11-12T06:58:04.970761Z`).
- Klien mengirim balik string itu **persis** di `expectedUpdatedAt`; server membandingkan sebagai parameter `$n::timestamptz`. Mismatch → `409 CONFLICT` (`Tenant changed since it was read; refresh expectedUpdatedAt`).

### D8 — `resolveOperatingWindow` satu-satunya sumber jam operasional

```ts
// src/modules/tenants/tenant-operating-hours.service.ts (di-export TenantsModule)
TenantOperatingHoursService.resolveOperatingWindow(
  tenantId: string,
  localDate: string,        // 'YYYY-MM-DD', tanggal lokal tenant/kampus
  client?: PoolClient,      // opsional; transaksi pemanggil
): Promise<OperatingWindow>

interface OperatingWindow {
  tenantId: string;
  timezone: string;               // timezone kampus
  localDate: string;
  weekday: number;                // 0..6, 0=Minggu (D12)
  isOpen: boolean;
  opensAt: string | null;         // 'HH:MM:SS' waktu lokal atau null
  closesAt: string | null;
  source: 'override' | 'weekly' | 'none';
}
```

Aturan: override tanggal mengalahkan jadwal weekly; baris `is_open=false`/`is_closed=true` atau baris yang tidak ada → `isOpen:false`; tenant archived / kampus nonaktif / tenant tidak ada → `404`; format/tanggal lokal tidak valid → `400`. Bila diberi `PoolClient`, method ini **read-only murni**: tidak menambah lock dan tidak membuka transaksi sendiri — pemanggil yang membutuhkan serialisasi (mis. checkout) mengunci baris tenant sendiri (`FOR SHARE`/`FOR UPDATE`). Availability sudah mengonsumenya untuk validasi slot; wave 2 (orders/checkout) wajib memakai kontrak yang sama.

### D12 — weekday

`weekday` adalah 0=Minggu … 6=Sabtu (konvensi `Date.getDay()` JS), dihitung dalam timezone tenant/kampus. `localDate` pada API adalah tanggal kalender lokal tenant; weekday dikurunkan dari tanggal lokal tersebut.

## Endpoint

### Publik (tanpa auth) — discovery

| Method | Path                                    | Keterangan                                                                                                                                                |
| ------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/campuses`                          | Daftar kampus **aktif**; `?search=` substring nama case-insensitive (wildcard LIKE di-escape), `?limit=` 1..100 (default 50, di-clamp server).            |
| GET    | `/v1/campuses/:campusId`                | Detail kampus aktif. Kampus nonaktif/tidak ada → `404` (tidak membocorkan eksistensi).                                                                    |
| GET    | `/v1/campuses/:campusId/tenants`        | Tenant non-archived di kampus aktif; `?status=open\|closed\|paused\|any` (default **open**). Kampus nonaktif → `404`. `meta` berisi nama/timezone kampus. |
| GET    | `/v1/tenants`                           | Daftar tenant non-archived lintas kampus aktif; filter `?campusId=`, `?status=` (default `any`), `?search=`, `?limit=`.                                   |
| GET    | `/v1/tenants/:tenantId`                 | Detail tenant (id, campusId, campusName, name, location, status, timezone). Archived / kampus nonaktif → `404`.                                           |
| GET    | `/v1/tenants/:tenantId/operating-hours` | Jadwal weekly (urut weekday) + override dari **hari lokal tenant** onwards (maks 90 baris).                                                               |

Data tenant `archived` tidak pernah muncul di endpoint publik mana pun; tenant archived juga ditolak `AccessService.requireTenant` sehingga staf lama kehilangan akses.

### Staf tenant (Bearer; permission granular per aksi)

| Method | Path                                                         | Permission                                                                           | Keterangan                                                                                                                                                                                                                                                                     |
| ------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PATCH  | `/v1/tenants/:tenantId/status`                               | `tenant.orders.pause` untuk `paused`; `tenant.capacity.manage` untuk `open`/`closed` | Transisi operasional (pengganti `PATCH /tenants/:id/availability/status` WIP lama). Body `{status, reason, expectedUpdatedAt}`. Audit `tenant.status_changed` (metadata `from`,`to`,`via:tenant_staff`).                                                                       |
| PUT    | `/v1/tenants/:tenantId/operating-hours`                      | `tenant.capacity.manage`                                                             | Ganti **seluruh** jadwal weekly: tepat 7 entri, tiap weekday 0..6 sekali. `isOpen=true` wajib `opensAt<closesAt`; `isOpen=false` wajib tanpa waktu. Body `{days[], reason}`. Audit `tenant.operating_hours_replaced`.                                                          |
| PUT    | `/v1/tenants/:tenantId/operating-hours/overrides/:localDate` | `tenant.capacity.manage`                                                             | Upsert override satu tanggal lokal (unik per tenant+tanggal). `isClosed=true` XOR jendela waktu. Tanggal lampau (menurut timezone tenant) ditolak `400`. `reason` (1..300) disimpan sebagai catatan publik sekaligus reason audit. Audit `tenant.operating_hour_override_set`. |
| DELETE | `/v1/tenants/:tenantId/operating-hours/overrides/:localDate` | `tenant.capacity.manage`                                                             | Hapus override (kembali ke weekly). Body `{reason}`. Tidak ada → `404`. Audit `tenant.operating_hour_override_removed`.                                                                                                                                                        |

Semua mutasi jam operasional mengunci baris tenant (`SELECT ... FOR UPDATE`) sehingga serial terhadap validasi slot yang mengunci tenant dengan `FOR SHARE`.

### Campus admin (Bearer; permission granular)

| Method | Path                                              | Permission              | Keterangan                                                                                                                                                          |
| ------ | ------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/campuses/:campusId/tenants`                  | `campus.tenants.manage` | Buat tenant baru, status awal selalu `closed` (keputusan konservatif: tenant dibuka eksplisit setelahnya). Body `{name, location, reason}`. Audit `tenant.created`. |
| PATCH  | `/v1/campuses/:campusId/tenants/:tenantId`        | `campus.tenants.manage` | Ubah `name`/`location` dengan `expectedUpdatedAt` (D7). Audit `tenant.updated` + metadata `before{name,location}`.                                                  |
| PUT    | `/v1/campuses/:campusId/tenants/:tenantId/status` | `campus.tenants.manage` | Transisi oversight `open/closed/paused` (bukan archive). Audit `tenant.status_changed` (`via:campus_admin`).                                                        |
| DELETE | `/v1/campuses/:campusId/tenants/:tenantId`        | `campus.tenants.manage` | **Archive** (bukan hapus). Body `{reason, expectedUpdatedAt}`. Lihat aturan arsip. Audit `tenant.archived` + metadata `before.status`.                              |
| POST   | `/v1/campuses/:campusId/tenants/:tenantId/owner`  | `campus.access.manage`  | Provisioning owner pertama. Body `{subjectUserId, reason}`. Lihat bagian provisioning.                                                                              |

Tenant milik kampus lain lewat path kampus yang salah → `404 Tenant not found` (tidak membocorkan eksistensi); admin tanpa membership kampus tsb → `403 Campus access denied`; membership tanpa permission yang diminta → `403 Campus permission denied`. Tenant `archived` diperlakukan `404` di semua jalur admin.

## Aturan bisnis

### Status tenant

- Enum DB: `open`, `closed`, `paused`, `archived` (CHECK `tenants_status_check`). Default create: `closed`.
- `archived` **terminal** lewat API: tidak ada unarchive/transisi keluar; hanya dicapai lewat endpoint archive dengan pemeriksaan dependensi.
- Transisi `open|closed|paused` → `open|closed|paused` diizinkan dari kedua jalur (staf & campus admin) selama permission cocok; server menolak `archived` sebagai target status endpoint (400).
- Setiap transisi menulis audit dengan `from`/`to`/aktor/reason dan `expectedUpdatedAt` (D7) mencegah lost update.

### Archive menolak saat masih ada ketergantungan aktif

Archive ditolak `409` bila tenant masih punya **komitmen pembeli aktif**:

1. `orders` berstatus `paid_awaiting_tenant|confirmed|preparing|ready_for_pickup` — order dibayar wajib diselesaikan/diputuskan lewat jalur kasus/refund, tidak boleh digantung oleh archive.
2. `schedule_proposals` berstatus `pending_buyer` — keputusan pembeli belum terjadi; timeout bukan persetujuan.
3. `slot_reservations` berstatus `reserved` — checkout sedang berjalan.
4. `pickup_slots` `open` dengan `ends_at > now()` — masih menjual slot masa depan.

Riwayat (`completed`/`declined`/`cancelled`, slot lampau, reservation `consumed`/`released`, proposal decided) **tidak** memblokir dan **tidak** dihapus: archive hanya mengubah status; data order/ledger/audit/membership tetap utuh (diuji). Menu tidak memblokir archive — setelah archived, tenant hilang dari discovery dan `requireTenant` menolak, sehingga menu tidak lagi terjangkau pembeli. Membership staf yang masih `active` menjadi tidak efektif (bukan dihapus) karena `requireTenant` mengecualikan tenant archived.

Pemeriksaan dependensi berjalan dalam transaksi yang sama dengan penguncian baris tenant (`FOR UPDATE`), jadi archive bersisian terserialisasi (diuji: dua archive paralel → tepat satu sukses).

### Jam operasional

- `tenant_operating_hours`: PK/unique `(tenant_id, weekday)`; weekday 0..6 (D12); CHECK `is_open=true` ⇔ `opens_at`/`closes_at` terisi dan `opens_at < closes_at`; `is_open=false` ⇔ keduanya NULL. Replace penuh (delete+insert 7 baris) dalam satu transaksi.
- `tenant_operating_hour_overrides`: PK/unique `(tenant_id, local_date)`; CHECK `is_closed=true` ⇔ waktu NULL; `is_closed=false` ⇔ jendela valid `opens_at < closes_at`. Upsert `ON CONFLICT (tenant_id, local_date)`.
- Validasi service mencerminkan CHECK DB (menolak sebelum menyentuh DB), dan constraint DB tetap diuji langsung sebagai jaring pengaman terakhir.
- `updated_at` disetel eksplisit `now()` pada setiap tulis.

### Provisioning terkontrol (tanpa backdoor, tanpa token statis)

**Owner tenant** — `POST /v1/campuses/:campusId/tenants/:tenantId/owner` (`campus.access.manage`):

- Hanya bootstrap **owner pertama**: ditolak `409` bila sudah ada owner aktif (transfer/multi-owner = keputusan produk terbuka, lihat batasan).
- Aktor ≠ subjek (tidak bisa angkat diri sendiri); subjek harus user `active` (`404` bila tidak).
- Mengambil advisory lock kunci **sama** dengan `AccessService.grantTenantMembership` (`hashtextextended(tenantId || ':' || subjectUserId)`) sehingga grant staf dan bootstrap owner untuk user yang sama terserialisasi (amanat docs/ACCESS.md).
- Konflik 409 dievaluasi **sebelum** validasi subjek: bila owner aktif sudah ada, operasi mustahil untuk subjek mana pun.
- Menulis `tenant_memberships(role='owner', owner_verified_at=now(), permissions='{}', status='active')`; membership staf existing untuk subjek dipromosikan (satu membership per user+tenant; tidak pernah menimpa baris owner aktif — guard `WHERE NOT (role='owner' AND status='active')`). Baris owner yang pernah di-revoke boleh di-provision ulang (re-bootstrap).
- Atomik: `access_audit_events(grant)` + `audit_events` `tenant.owner_provisioned` (aktor, subjek di metadata, reason, waktu).
- Owner hasil provisioning lulus `requireTenant` termasuk permission finance (owner terverifikasi).

**Campus admin** — tanpa endpoint publik (amanat docs/ACCESS.md: tidak ada endpoint publik yang memberi akses kampus). Service-only:

```ts
// src/modules/campuses/campus-provisioning.service.ts (di-export CampusesModule)
CampusProvisioningService.provisionCampusAdmin(
  { actor: { userId } | { service }, campusId, subjectUserId,
    permissions: CampusPermission[], reason },
  client?: PoolClient,
): Promise<CampusMembershipResult>
CampusProvisioningService.revokeCampusAdmin(
  { actor, campusId, subjectUserId, reason },
  client?: PoolClient,
): Promise<CampusMembershipResult>
```

- Actor `service` (principal mesin tepercaya, pola `^[a-z][a-z0-9._-]{0,79}$`) hanya untuk bootstrap pertama dari jalur terkontrol (script/worker yang dijalankan operator/root).
- Actor `userId` wajib membership aktif dengan `campus.access.manage` di kampus tsb; tidak bisa provision/revoke diri sendiri.
- Permissions eksplisit dari `CAMPUS_PERMISSIONS` (non-kosong, unik, tanpa nilai tak dikenal); tidak ada role superuser implisit.
- Upsert `(campus_id, user_id)`: re-provision mengaktifkan kembali membership revoked / mengganti daftar permission. Revoke → status `revoked` + `revoked_at`; `requireCampus` langsung menolak sesudahnya.
- Audit: `audit_events` (`campus.admin_provisioned`/`campus.admin_revoked`) selalu; `access_audit_events(grant|revoke)` **hanya untuk actor user** — lihat batasan skema di bawah.

## Keputusan & asumsi

Poin 1–6 di bawah **disetujui root** (keputusan task-3, 12 November 2026); sisanya konvensi implementasi.

1. **Create tenant selalu `closed`** — membuka tenant adalah aksi eksplisit terpisah (endpoint status), supaya onboarding tidak tak-sengaja membuat tenant terlihat siap menerima order.
2. **`reason` wajib (1..500) di semua mutasi pengelola** dan disimpan di audit; untuk override juga disimpan sebagai catatan publik (maks 300 sesuai kolom).
3. **Aturan archive** seperti di atas (4 blocker komitmen aktif; riwayat tidak memblokir dan tidak dihapus).
4. **Archived = 404 di jalur admin maupun publik** (konsisten, tidak membocorkan data), kecuali archive-ulang yang juga 404; konflik `expectedUpdatedAt` = 409.
5. **Override tidak boleh untuk tanggal lampau** (menurut tanggal lokal kampus) — override masa lalu tidak memengaruhi validasi slot dan rawan disalahgunakan untuk memanipulasi riwayat tampilan.
6. **Permission mapping status staf**: `paused` → `tenant.orders.pause`; `open`/`closed` → `tenant.capacity.manage` (mengikuti model permission pilot; pause adalah aksi operasional dapur, buka/tutup rutin adalah pengelolaan kapasitas).
7. **Error contract**: memakai filter global yang ada — 400 `VALIDATION_ERROR`, 401 code `unauthorized` (dideklarasikan AuthGuard), 403 `FORBIDDEN`, 404 `NOT_FOUND`, 409 `CONFLICT`.
8. **Pencarian**: `search` adalah substring ILIKE dengan escape `\`, `%`, `_` (tidak ada full-text search / fuzzy — cukup untuk pilot).

## Batasan & pekerjaan tersisa

- **Jendela lintas tengah malam belum didukung** (CHECK `opens_at < closes_at` di kedua tabel; keputusan root untuk pilot): kantin malam yang buka lewat tengah malam (mis. 22:00–02:00) tidak dapat dimodelkan; butuh keputusan produk + perubahan skema bila diperlukan.
- **Bootstrap campus admin oleh actor service tidak menulis `access_audit_events`** karena kolom `actor_user_id` NOT NULL di skema access (keputusan root task-3; jejak tetap ada di `audit_events` dengan `actor_service`). Keputusan terbuka di root: kolom `actor_service` + CHECK XOR pada `access_audit_events` di migrasi berikutnya (menyentuh slice KAN-24 yang sudah diterima).
- **Transfer/multi owner tenant belum ada** (409 untuk owner kedua — disetujui root untuk pilot): endpoint provisioning hanya bootstrap owner pertama. Transfer owner dan unarchive tenant adalah **keputusan produk terbuka**.
- **Belum ada endpoint revoke/pause campus membership via HTTP** (by design; service-only). Permintaan UI untuk manajemen akses kampus perlu keputusan root.
- **Outbox event tenant DITUNDA root** (mis. `tenant.paused` di REQUIREMENTS-API §9): `DOMAIN_EVENT_TYPES` (file root) tidak boleh ditambah dari slice ini; perubahan status saat ini hanya tercatat di audit. Tercatat sebagai **usulan produk** bila event/notifikasi tenant diperlukan.
- `GET /v1/campuses/:campusId/tenants` dan `GET /v1/tenants` belum berpaginasi cursor (hanya `limit` clamp 1..100) — cukup untuk volume pilot.

## Test

Dijalankan terhadap PostgreSQL nyata (`antriin_tenantcampus`, migrasi 0000–0007), `node:test` + `node:assert`, tanpa stub DB:

- `test/campuses.spec.ts` — discovery kampus aktif/search/limit, 404 nonaktif, daftar tenant per kampus (default open, archived tak pernah bocor), provisioning campus admin (service bootstrap + actor user + akses langsung efektif), revoke menghentikan `requireCampus`, re-provision, penolakan self/inactive/permission tak dikenal/kampus nonaktif, jejak audit ganda + append-only, limitasi `access_audit_events` untuk service actor (diassert eksplisit).
- `test/tenants-admin.spec.ts` — list/get publik + filter + search, create/update/status/archive oleh campus admin, cross-campus 403/404, viewer tanpa `campus.tenants.manage` 403, D7 (format mikrodetik + stale token 409), transisi staf vs permission (`orders.pause` vs `capacity.manage`), audit `from/to/via`, archive ditolak 4 blocker dependensi (order aktif, proposal pending, reservation reserved, slot open masa depan) lalu sukses setelah diselesaikan, riwayat tidak terhapus, archived → 404 publik + `requireTenant` menolak, archive konkuren → tepat satu sukses.
- `test/tenants-operating-hours.spec.ts` — replace weekly + normalisasi `HH:MM`→`HH:MM:SS` + NULL untuk hari tutup, validasi bentuk (7 hari unik, jendela invalid, closed-with-times), permission/scope, **penolakan langsung oleh constraint DB** (weekday check, time check XOR, unique tenant+weekday, unique tenant+local_date, window check override), override upsert/unik, tanggal lampau/format invalid ditolak, audit set/remove, `resolveOperatingWindow`: weekly, override mengalahkan weekly (termasuk `isClosed=true` menutup tanggal tsb), source `none`, weekday D12 (fakta kalender tetap), 404 archived, jalur `PoolClient` read-only (D8), list publik hanya override mendatang.
- `test/tenants-provisioning.spec.ts` — bootstrap owner pertama (membership + `owner_verified_at` + access_audit + audit_events + lulus `requireTenant` finance), owner hasil provisioning dapat grant/revoke staf dan **revocation langsung menghentikan akses**, penolakan owner kedua (409), tanpa `campus.access.manage` (403), lintas kampus (403/404), self-provision, user inactive, tenant archived, reason kosong, promosi membership staf → owner (tanpa duplikasi baris), **kompetisi paralel dua bootstrap → tepat satu owner aktif**, audit append-only (UPDATE/DELETE ditolak trigger).
- `test/tenants-http.spec.ts` — kontrak HTTP end-to-end (Nest+Fastify, service riil, AuthGuard di-override token→principal): kode error contract (`unauthorized` 401, `VALIDATION_ERROR` 400 termasuk unknown field via `forbidNonWhitelisted`, `FORBIDDEN` 403, `CONFLICT` 409, `NOT_FOUND` 404), create→PATCH round-trip `expectedUpdatedAt` mikrodetik lewat HTTP (D7), PATCH status staf, PUT weekly 400/200, provisioning owner 201 lalu 409, DELETE archive dengan body lalu GET 404.
