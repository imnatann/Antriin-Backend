# Modul Katalog (menu tenant)

Slice katalog memiliki tabel `menu_categories`, `menu_items`, `menu_option_groups`, `menu_option_choices` (migrasi 0006; kolom `menu_items.image_ref`/`archived_at` menyusul di 0007). Pickup slot dan jam operasional dimiliki slice availability/tenant-campus; katalog hanya membacanya lewat kontrak yang sudah ada.

Status: **siap review** — CRUD tenant, discovery pembeli, dan `CatalogService.quote` diimplementasikan dengan test PostgreSQL nyata. Belum ada integrasi checkout (slice order memanggil `quote`).

## Kontrak utama

### CatalogService.quote(client, tenantId, slotId, items)

Dipakai slice order saat checkout. Sifat:

- **Read-only dan ADVISORY**: tidak mereservasi kapasitas slot, tidak memindahkan uang, tidak menulis baris apa pun, dan **tidak mengunci baris `pickup_slots`** (mode lock `'none'`). Quote tidak menjamin harga/slot; otoritas validasi akhir ada di `reserveForCheckout` (`FOR UPDATE`). Dijalankan di dalam transaksi pemanggil (`PoolClient`).
- Input `items`: `{ menuItemId, quantity, optionIds }[]`, 1..50 baris, tanpa itemId duplikat, maks 50 opsi unik per baris, `quantity` integer **1..200** (konstanta `MAX_QUOTE_LINE_QUANTITY`; batas DB order 1..999, batas operasional pilot 1..200 — keputusan root R1-22, dapat diubah tanpa migrasi).
- Validasi slot memakai `AvailabilityService.assertBookableSlot(client, tenantId, slotId, 'none')` (kontrak lintas slice; keputusan root 12 Nov 2026 pasca temuan deadlock 40P01): validasi read-only **tanpa lock baris slot** — slot harus open, milik tenant, mulai di masa depan, masih berkapasitas, dalam jam operasional; tenant harus `open` dan kampus `active`. Hasilnya snapshot point-in-time, bukan otoritas kapasitas. Urutan checkout resmi (D15): **INSERT orders → reserve (`reserveForCheckout`, `FOR UPDATE`) → debit wallet**.
- Hanya item `active` pada kategori `active` yang dapat di-quote; `sold_out`/`archived`/kategori archived → 409.
- Setiap grup opsi **aktif** pada item wajib dipenuhi: `min_selections <= jumlah terpilih <= max_selections`; opsi harus milik item tersebut → 400 bila tidak.
- Snapshot server per baris: identitas tenant (id, campusId, name, timezone), slot (id, startsAt, endsAt, version), `menuVersion` item, versi grup (`groupVersion`) dan opsi (`optionVersion`), nama/deskripsi/kategori, `basePriceMinor`, `unitPriceMinor`, `quantity`.

**Rumus harga (DIKUNCI root, wave1 D12):**

```text
unit_price_minor  = base_unit_price_minor + SUM(price_delta_minor opsi terpilih per unit)
line_total_minor  = unit_price_minor * quantity
subtotal_minor    = SUM(line_total_minor)
total_minor       = subtotal_minor   (pilot tanpa fee/pajak/diskon — PILOT-POLICY)
```

- Semua nilai uang adalah integer minor (IDR, eksponen 0) yang dihitung dengan `bigint` dan dikembalikan sebagai **string desimal**; tidak ada float, tidak ada konversi bigint→number. Overflow dijaga: total > 10^38-1 → 400.
- **Total 0 ditolak** (`Quote total must be greater than zero`, 400) mengikuti CHECK `subtotal_minor > 0` pada orders (D12).
- `quoteHash` = SHA-256 atas JSON kanonik snapshot: field dibentuk dengan urutan kunci tetap, opsi per baris diurutkan `(groupId, choiceId)`, dan **baris item diurutkan `menuItemId` khusus untuk hash** (urutan cart tidak memengaruhi hash; array `items` pada respons tetap mengikuti urutan permintaan). Input sama → hash sama; beda kuantitas/opsi/harga/versi/slot → hash beda.

### CRUD tenant (semua mutasi)

- Otorisasi: `AccessService.requireTenant(actorUserId, tenantId, 'tenant.menu.manage', client)` **di dalam transaksi yang sama** dengan mutasi, sehingga revoke staf terserialisasi terhadap tulisan. Staf pickup tidak pernah lolos walaupun baris grant-nya dipalsukan (dicek role di AccessService).
- Scope: setiap `SELECT/UPDATE/INSERT` menyertakan `tenant_id`; resource tenant lain → 404 (bukan 403) agar keberadaan id tidak bocor. FK komposit `(tenant_id, category_id)`, `(tenant_id, menu_item_id)`, `(tenant_id, group_id)` menolak referensi lintas tenant di level DB (23503).
- Optimistic concurrency: item/grup/opsi memakai `expectedVersion` (wajib di PATCH); mismatch → 409 `... changed`. Kategori **tidak punya kolom version** di schema, jadi tidak ada guard versi untuk kategori (lihat Batasan).
- Versioning: `menu_items.version` naik saat field item berubah **dan** saat komposisi opsinya berubah (create/update/archive grup atau choice). `menu_option_groups.version` naik saat grup berubah dan saat choice-nya berubah. `menu_option_choices.version` naik saat choice berubah. Konsumen snapshot order dapat membandingkan versi ini untuk mendeteksi katalog basi.
- Uang: `priceMinor`/`priceDeltaMinor` adalah string desimal integer >= 0, maks 38 digit (pola `^(0|[1-9][0-9]{0,37})$`); delta opsi tidak boleh negatif (tidak ada opsi diskon di pilot). CHECK DB (`trunc`, `>= 0`, `< 1e38`) adalah lapisan terakhir.
- Soft delete: **tidak ada hard delete** (keputusan root; endpoint DELETE pun hanya mengarsipkan). `DELETE` mengarsipkan (`status='archived'`, item juga mengisi `archived_at=now()`; reaktivasi mengosongkannya lagi — CHECK 0007 **bidirectional**: `archived_at` terisi hanya saat archived dan wajib terisi saat archived). Archive idempoten. Snapshot order tidak punya FK ke katalog, jadi arsip aman untuk riwayat.
- **Audit wajib untuk perubahan berdampak uang/status** (keputusan root, AGENTS.md "keputusan pengelola"): `AuditService.append` dipanggil dalam transaksi yang sama untuk perubahan harga item (`tenant.menu.item.price_changed`), perubahan harga delta opsi (`tenant.menu.option.price_changed`), transisi status item (`tenant.menu.item.sold_out` / `.available` / `.archived` / `.restored`), dan arsip/reaktivasi kategori, grup opsi, choice (`tenant.menu.category|option_group|option.archived|restored`). `reason` (1..300 char) **wajib dari DTO** untuk mutasi tersebut (body PATCH, atau query param `reason` untuk DELETE); actor selalu dari sesi, tidak pernah dari body. Metadata audit hanya nilai non-sensitif (harga/status lama→baru). Create dan perubahan nama/deskripsi/gambar/urutan tidak diaudit.
- Unique: nama kategori unik per tenant, nama choice unik per grup → pelanggaran 23505 dipetakan ke 409.
- `updated_at` diset eksplisit (`now()`) pada setiap mutasi; tidak ada trigger DB. Timestamp respons memakai format mikrodetik UTC langsung dari PostgreSQL (`to_char(... US"Z")`), tidak pernah di-round-trip lewat JS `Date` (konvensi root D7).
- `imageRef` (opsional, <=500 char) adalah referensi media opaque; kirim string kosong untuk menghapus. Pipeline media bukan milik slice ini.

### Discovery pembeli (publik, tanpa auth)

- `GET /v1/tenants/:tenantId/menu` — kategori aktif + item + grup/choice aktif, nested. Hanya status `active` dan `sold_out` (buyer melihat ketersediaan; `archived` tidak pernah bocor). Filter: `status=active|sold_out`, `search` (substring nama item, case-insensitive, metakarakter LIKE di-escape sehingga literal), `categoryId`. Kategori tanpa item cocok tidak ditampilkan. Cap 200 item + `meta.truncated`. Tenant archived atau kampus inactive → 404.
- `GET /v1/tenants/:tenantId/menu/items/:itemId` — detail item buyer-visible (404 bila archived/kategori archived/tenant lain).
- Membaca menu tidak mensyaratkan tenant `open` (paused/closed tetap bisa dilihat; checkout yang menolak), sesuai requirement 3.2.

## Endpoint

| Method | Path                                                                | Auth   | Permission           |
| ------ | ------------------------------------------------------------------- | ------ | -------------------- |
| GET    | `/v1/tenants/:tenantId/menu`                                        | publik | —                    |
| GET    | `/v1/tenants/:tenantId/menu/items/:itemId`                          | publik | —                    |
| GET    | `/v1/tenants/:tenantId/menu/manage`                                 | bearer | `tenant.menu.manage` |
| POST   | `/v1/tenants/:tenantId/menu/categories`                             | bearer | `tenant.menu.manage` |
| PATCH  | `/v1/tenants/:tenantId/menu/categories/:categoryId`                 | bearer | `tenant.menu.manage` |
| DELETE | `/v1/tenants/:tenantId/menu/categories/:categoryId?reason=` (arsip) | bearer | `tenant.menu.manage` |
| POST   | `/v1/tenants/:tenantId/menu/items`                                  | bearer | `tenant.menu.manage` |
| PATCH  | `/v1/tenants/:tenantId/menu/items/:itemId`                          | bearer | `tenant.menu.manage` |
| DELETE | `/v1/tenants/:tenantId/menu/items/:itemId?reason=` (arsip)          | bearer | `tenant.menu.manage` |
| POST   | `/v1/tenants/:tenantId/menu/items/:itemId/option-groups`            | bearer | `tenant.menu.manage` |
| PATCH  | `/v1/tenants/:tenantId/menu/option-groups/:groupId`                 | bearer | `tenant.menu.manage` |
| DELETE | `/v1/tenants/:tenantId/menu/option-groups/:groupId?reason=` (arsip) | bearer | `tenant.menu.manage` |
| POST   | `/v1/tenants/:tenantId/menu/option-groups/:groupId/choices`         | bearer | `tenant.menu.manage` |
| PATCH  | `/v1/tenants/:tenantId/menu/choices/:choiceId`                      | bearer | `tenant.menu.manage` |
| DELETE | `/v1/tenants/:tenantId/menu/choices/:choiceId?reason=` (arsip)      | bearer | `tenant.menu.manage` |

Semua endpoint punya decorator Swagger/OpenAPI; body divalidasi runtime oleh `ValidationPipe` global (`whitelist`, `forbidNonWhitelisted`, `transform`) dan divalidasi ulang di service (defense in depth untuk pemanggil internal). Error mengikuti `ApiExceptionFilter` (`VALIDATION_ERROR` 400, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409).

Aturan grup opsi: `0 <= minSelections <= maxSelections`, `maxSelections >= 1`, keduanya <= 50 (selaras cap 50 opsi/baris pada quote). Item dibuat dengan `version=1`, currency selalu `IDR` (CHECK DB).

## Keputusan & asumsi

1. **Batas quote** (dari draft root, dipertahankan): 1..50 baris, <=50 opsi/baris; quantity 1..200 per baris (R1-22). Bukan aturan finansial; dapat diubah produk.
2. **Arsip kategori tidak mengarsipkan itemnya** (DISETUJUI root): quote dan discovery memfilter join `cat.status='active'` sehingga item di kategori archived otomatis tidak terlihat/tidak dapat di-quote, dan reaktivasi kategori memulihkannya. Version item tidak di-bump saat kategorinya diarsipkan — checkout mendeteksi lewat kegagalan quote (409), bukan perbandingan versi.
3. **Perubahan deskripsi juga menaikkan version item** (konservatif): setiap mutasi item menaikkan version agar snapshot konsumen selalu bisa mendeteksi perubahan; requirement hanya mewajibkan nama/harga/opsi.
4. **Quote tidak mengunci baris slot** (keputusan root 12 Nov 2026): reviewer independen membuktikan `assertBookableSlot(..., 'share')` di quote lalu `FOR UPDATE` di `reserveForCheckout` dalam transaksi yang sama = lock upgrade → deadlock 40P01 pada checkout paralel (bukti reviewer: 8 paralel = 7 deadlock). Kini quote memakai mode `'none'` (plain SELECT; validasi status/kapasitas/jam operasional tetap jalan) dan bersifat **advisory**; otoritas akhir kapasitas ada di `reserveForCheckout` (`FOR UPDATE`) sesuai PILOT-POLICY ("kapasitas direservasi saat pembayaran, bukan saat quote"). Baris tenant/kampus pada query quote tetap `FOR SHARE` (kompatibel antar checkout paralel, tanpa jalur upgrade ke `FOR UPDATE`), dan baris katalog (item/kategori/grup/opsi) tetap `FOR SHARE` untuk konsistensi snapshot dalam transaksi checkout. Urutan checkout resmi D15: INSERT orders → reserve → debit.
5. **Audit** diwajibkan root untuk mutasi berdampak uang/status (lihat di atas); create/edit kosmetik tidak diaudit agar audit log tidak bising. **Outbox/notifikasi perubahan menu DITUNDA sebagai keputusan produk terbuka** (keputusan root): `DOMAIN_EVENT_TYPES` belum punya event menu dan slice katalog tidak boleh menambah event type sendiri — tercatat sebagai usulan ke root bila notifikasi "menu berubah" diinginkan.
6. **Taksonomi audit DISETUJUI root (12 Nov 2026) sebagai taksonomi baku katalog**: aksi `tenant.menu.<entitas>.<kejadian>` (dot-style, valid terhadap pola action AuditService) dengan targetType `menu_item`/`menu_category`/`menu_option_group`/`menu_option_choice`. Transisi sold_out→active diaudit sebagai `tenant.menu.item.available`. Slice lain yang menambahkan aksi audit disarankan mengikuti pola setara `tenant.<domain>.<entitas>.<kejadian>` agar konsisten.
7. Pembuatan item mensyaratkan kategori **active** (409 bila archived) agar menu yang dibangun selalu terlihat pembeli.

## Batasan

- Kategori tidak punya guard optimistic concurrency (schema tanpa kolom version); dua rename/reorder bersamaan bisa saling menimpa (**last-write-wins**). Risiko ini DITERIMA root untuk pilot; usulan menambah kolom `menu_categories.version` lewat migrasi baru DICATAT sebagai pekerjaan schema wave berikutnya (bukan wave ini, milik root/schema-fixer).
- `image_ref` hanya menyimpan referensi; tidak ada upload/validasi media.
- Pencarian hanya substring nama item (bukan deskripsi/kategori), tanpa pagination di atas cap 200; rekomendasi/pencarian lanjutan di luar slice ini (requirement 3.2 poin 4).
- `quote` belum dikonsumsi HTTP; slice order yang akan memanggilnya dalam transaksi checkout bersama reserve + debit wallet.

## Test

`test/catalog.spec.ts` (PostgreSQL nyata, node:test): CRUD + version bump, konkurensi update paralel (satu menang, satu 409), isolasi lintas tenant (403/404 + FK komposit 23503), penolakan harga negatif/pecahan di service dan CHECK DB (23514), permission `tenant.menu.manage` (kitchen tanpa izin, pickup dengan grant palsu, stranger), arsip idempoten + tersembunyi dari buyer, item aktif di kategori terarsip ditolak quote (409) + hilang dari discovery dan pulih saat kategori direaktivasi, audit immutable (actor/reason/action untuk price change, sold_out/available, archive/restore item+kategori+opsi; reason wajib, reason kosong ditolak), CHECK archived_at dua arah (23514), discovery filter/search literal/unik 409, quote: total benar dengan delta opsi, hash deterministik + kanonik (reorder baris = hash sama), total 0 ditolak, item sold_out/archived/tenant lain ditolak, min/max opsi, quantity 1..200, slot tidak tereservasi, dan **quote tidak memegang lock baris slot** (transaksi lain dapat memegang `FOR UPDATE` pada slot yang sama tanpa memblokir quote; diverifikasi dengan `lock_timeout` 2 detik — sebelum fix: RED 55P03 setelah ~2028ms, sesudah mode `'none'`: GREEN ~25ms).

`test/catalog-http.spec.ts`: kontrak HTTP (auth 401 admin, publik 200 discovery, whitelist menolak field tak dikenal, uang non-string/negatif 400, `expectedVersion` wajib, principal sesi diteruskan ke service).

Cara menjalankan (DB slice `antriin_catalog`, migrasi 0006+0007 harus sudah diterapkan):

```sh
npx tsc -p tsconfig.test.json --outDir .test-dist-catalog
node --test .test-dist-catalog/test/catalog.spec.js .test-dist-catalog/test/catalog-http.spec.js
```
