/**
 * Hand-written prose for the API guide. Everything derivable from the live
 * OpenAPI document (endpoints, objects, status codes) is generated at request
 * time in api-guide.service.ts; only conventions the document cannot express
 * live here.
 */
export type Block =
  | { kind: 'h2'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'table'; head: string[]; rows: string[][] };

export const GUIDE_INTRO: Block[] = [
  {
    kind: 'p',
    text: 'Panduan lengkap Antriin API untuk implementasi frontend. Halaman ini dibuat dari dokumen OpenAPI yang sedang berjalan, jadi daftar endpoint dan object di bawah selalu sama dengan kode yang aktif. Versi mesin tersedia di `/api/v1/guide/openapi.json`.',
  },
  {
    kind: 'table',
    head: ['Hal', 'Nilai'],
    rows: [
      ['Base URL lokal', '`http://localhost:3000/api/v1`'],
      [
        'Prefix global',
        '`/api/v1` — semua path di bawah sudah termasuk prefix',
      ],
      ['Format', 'JSON, `Content-Type: application/json`'],
      [
        'Autentikasi',
        '`Authorization: Bearer <sessionToken>` (token opaque, bukan JWT)',
      ],
      ['Envelope sukses', '`{ data }` atau `{ data, meta }`'],
      [
        'Envelope error',
        '`{ error: { code, message, details?, request_id } }`',
      ],
    ],
  },
  {
    kind: 'p',
    text: 'Halaman ini, versi Markdown-nya, dan `openapi.json` hanya aktif bila `SWAGGER_ENABLED=true`.',
  },
];

export const GUIDE_AUTH: Block[] = [
  { kind: 'h2', text: '1. Autentikasi' },
  {
    kind: 'p',
    text: 'Login memakai OTP, bukan password. Sesi berupa token opaque yang disimpan sebagai hash di server; token mentah hanya dikembalikan sekali saat verifikasi berhasil. Simpan di cookie httpOnly lewat BFF atau di memory, jangan di localStorage.',
  },
  {
    kind: 'code',
    lang: 'http',
    text: [
      'POST /api/v1/auth/otp-challenges',
      '{ "channel": "email", "destination": "budi@student.ac.id", "displayName": "Budi" }',
      '-> 201 { "data": { "challengeId": "...", "expiresAt": "..." } }',
      '',
      'POST /api/v1/auth/otp-challenges/{challengeId}/verify',
      '{ "code": "123456" }',
      '-> 200 { "data": { "sessionToken": "...", "expiresAt": "...", "user": { "id": "...", "displayName": "Budi" } } }',
    ].join('\n'),
  },
  {
    kind: 'list',
    items: [
      '`POST /auth/sessions/refresh` merotasi token: token lama langsung tidak berlaku, simpan token baru.',
      '`DELETE /auth/sessions/current` mencabut sesi aktif.',
      'Verifikasi email kampus terpisah dari login: `POST /auth/campus-email-verifications`, `POST /auth/campus-email-verifications/{id}/verify`, dan `GET /auth/campus-email-verifications/current` untuk status.',
      'Adapter OTP default mengembalikan **503** karena pengiriman WhatsApp/email belum aktif. Di development pakai port delivery terkontrol; jangan menganggap OTP benar-benar terkirim.',
      'Endpoint OTP dan verifikasi memakai rate limit per IP: **429** dengan `error.retry_after_seconds` dan header `Retry-After`.',
    ],
  },
];

export const GUIDE_CONVENTIONS: Block[] = [
  { kind: 'h2', text: '2. Konvensi respons' },
  { kind: 'h3', text: '2.1 Sukses' },
  {
    kind: 'list',
    items: [
      'Objek tunggal: `{ "data": { ... } }`.',
      'Daftar: `{ "data": [ ... ], "meta": { "next_cursor": "..." | null } }`.',
      '`POST` pembuatan menjawab **201**; aksi/transisi pada resource yang sudah ada menjawab **200**; `DELETE` ulasan menjawab **200** dengan objek hasil, bukan 204.',
      '`POST /orders` mengembalikan `meta.replayed` untuk membedakan order baru dari replay idempotent.',
    ],
  },
  { kind: 'h3', text: '2.2 Error' },
  {
    kind: 'code',
    lang: 'json',
    text: [
      '{',
      '  "error": {',
      '    "code": "INSUFFICIENT_BALANCE",',
      '    "message": "Wallet balance is not sufficient",',
      '    "details": ["hanya untuk error validasi 400"],',
      '    "request_id": "req-1",',
      '    "retry_after_seconds": 30',
      '  }',
      '}',
    ].join('\n'),
  },
  {
    kind: 'p',
    text: '`code` stabil dan aman dipakai sebagai kunci terjemahan; `message` untuk manusia dan bisa berubah. Header `x-request-id` selalu ada dan nilainya sama dengan `error.request_id` — sertakan saat melaporkan bug. Error 5xx tidak pernah membocorkan pesan database/provider.',
  },
  {
    kind: 'table',
    head: ['Status', 'code default', 'Arti untuk UI'],
    rows: [
      [
        '400',
        '`VALIDATION_ERROR`',
        'Input salah; tampilkan `details` bila ada',
      ],
      [
        '401',
        '`UNAUTHENTICATED`',
        'Token tidak ada/kedaluwarsa, arahkan ke login',
      ],
      ['403', '`FORBIDDEN`', 'Sesi sah tetapi role/scope tidak berhak'],
      [
        '404',
        '`NOT_FOUND`',
        'Resource tidak ada **atau** bukan milik pemanggil (sengaja tidak dibedakan)',
      ],
      [
        '409',
        '`CONFLICT`',
        'State berubah, saldo kurang, atau replay berbeda — muat ulang data',
      ],
      ['413', '`PAYLOAD_TOO_LARGE`', 'Body melebihi 1 MB'],
      ['429', '`RATE_LIMITED`', 'Baca `retry_after_seconds`'],
      [
        '503',
        '`SERVICE_UNAVAILABLE`',
        'Dependency/provider mati; tampilkan status pending, jangan ulangi mutasi tanpa idempotency key',
      ],
    ],
  },
  {
    kind: 'p',
    text: 'Banyak endpoint memakai `code` yang lebih spesifik (mis. `REVIEW_ALREADY_EXISTS`, `CASE_ALREADY_DECIDED`). Cocokkan pada `code`, jangan pada `message`.',
  },
  { kind: 'h3', text: '2.3 Waktu' },
  {
    kind: 'p',
    text: 'Semua timestamp adalah string UTC mikrodetik: `YYYY-MM-DDTHH:MM:SS.ffffffZ`. Jangan melewatkannya ke `new Date()` lalu mengirim balik hasil `toISOString()` — itu memotong ke milidetik dan merusak optimistic concurrency. Kirim balik string apa adanya. Konversi zona waktu hanya untuk tampilan; setiap resource membawa timezone IANA-nya sendiri.',
  },
  { kind: 'h3', text: '2.4 Uang' },
  {
    kind: 'p',
    text: 'Semua nominal adalah string desimal satuan terkecil (IDR rupiah bulat, tanpa desimal) beserta kode `currency`. Jangan memakai `number` atau `parseFloat` untuk aritmetika: presisi hilang di atas 2^53 dan pembulatan floating point tidak boleh menyentuh uang. Format tampilan dengan `Intl.NumberFormat("id-ID")` setelah `BigInt(amountMinor)`.',
  },
  {
    kind: 'code',
    lang: 'json',
    text: '{ "amountMinor": "25000", "currency": "IDR" }   // Rp25.000',
  },
  { kind: 'h3', text: '2.5 Pagination' },
  {
    kind: 'list',
    items: [
      'Cursor opaque: kirim `?cursor=<meta.next_cursor>&limit=<n>`. Jangan menebak isi cursor.',
      '`meta.next_cursor = null` berarti halaman terakhir.',
      'Batas umum `limit` 1..100 (default 25); notifikasi 1..50.',
      'Cursor rusak dijawab **400**.',
    ],
  },
  { kind: 'h3', text: '2.6 Idempotency' },
  {
    kind: 'list',
    items: [
      '`POST /orders` **wajib** header `Idempotency-Key`: 8–200 karakter `A-Z a-z 0-9 . _ :`. Tanpa header → `IDEMPOTENCY_KEY_REQUIRED`; bentuk salah → `IDEMPOTENCY_KEY_INVALID`.',
      '`POST /wallet/topups` memakai `idempotencyKey` **di body** dengan pola yang sama.',
      'Replay dengan key dan payload identik mengembalikan hasil sama tanpa efek baru. Key sama dengan payload berbeda → **409**.',
      'Buat key sekali per aksi pengguna, simpan, lalu pakai ulang saat retry jaringan.',
    ],
  },
];

export const GUIDE_PERMISSIONS: Block[] = [
  { kind: 'h2', text: '3. Role dan permission' },
  {
    kind: 'p',
    text: 'Otorisasi diperiksa di server untuk setiap request: sesi, lalu membership aktif, lalu permission, lalu scope resource. Frontend cukup menyembunyikan aksi yang pasti ditolak, bukan menggantikan pemeriksaan server. Resource milik pengguna lain dijawab **404**, bukan 403.',
  },
  { kind: 'h3', text: '3.1 Tenant (staf kantin)' },
  {
    kind: 'table',
    head: ['Role', 'Permission yang bisa dimiliki', 'Catatan'],
    rows: [
      [
        '`owner`',
        'semua `tenant.*`',
        'Wajib `owner_verified_at` terisi; tanpa itu seluruh akses tenant ditolak 403',
      ],
      [
        '`kitchen`',
        '`tenant.orders.read`, `tenant.orders.accept`, `tenant.orders.prepare`, `tenant.orders.pause`, `tenant.menu.manage`, `tenant.capacity.manage`, `tenant.reviews.reply`, `tenant.incidents.report`',
        'Tidak pernah mendapat permission finansial',
      ],
      [
        '`pickup`',
        '`tenant.orders.read`, `tenant.orders.handover`, `tenant.incidents.report`',
        'Hanya serah terima; tidak bisa menyiapkan atau menerima order',
      ],
    ],
  },
  {
    kind: 'p',
    text: 'Permission staf bersifat interseksi: role harus mengizinkan permission itu **dan** membership harus memberikannya secara eksplisit. `tenant.finance.read`, `tenant.bank_account.manage` dan `tenant.payout.request` hanya untuk owner terverifikasi — jangan tampilkan menu rekening/pencairan untuk role lain.',
  },
  { kind: 'h3', text: '3.2 Kampus (pengelola)' },
  {
    kind: 'table',
    head: ['Permission', 'Membuka'],
    rows: [
      [
        '`campus.transactions.read`',
        'Ringkasan transaksi, refund, payout kampus, dashboard',
      ],
      [
        '`campus.tenants.manage`',
        'Buat/ubah/arsipkan tenant dan status tenant',
      ],
      ['`campus.access.manage`', 'Kelola staf dan akses'],
      [
        '`campus.reviews.moderate`',
        'Antrean moderasi ulasan dan keputusan keep/hide',
      ],
      [
        '`campus.cases.read` / `campus.cases.decide`',
        'Baca kasus / memutuskan status kasus',
      ],
      [
        '`campus.refunds.initiate`',
        'Membuat refund dan menyetujui pembatalan lewat kasus',
      ],
      ['`campus.payouts.read`', 'Memantau payout tenant'],
      ['`campus.audit.read`', 'Membaca audit kampus'],
      [
        '`campus.ai_reviews.decide`',
        'Dicadangkan untuk tinjauan risiko — belum ada endpointnya',
      ],
    ],
  },
  { kind: 'h3', text: '3.3 Publik tanpa token' },
  {
    kind: 'list',
    items: [
      '`GET /health/live`, `GET /health/ready`',
      '`GET /campuses`, `GET /campuses/{id}`, `GET /campuses/{id}/tenants`',
      '`GET /tenants`, `GET /tenants/{id}`, `GET /tenants/{id}/menu`, `GET /tenants/{id}/menu/items/{itemId}`',
      '`GET /tenants/{id}/availability`, `GET /tenants/{id}/operating-hours`, `GET /tenants/{id}/reviews`',
      '`POST /webhooks/payments/{provider}` (server-to-server, memakai signature)',
    ],
  },
];

export const GUIDE_FLOWS: Block[] = [
  { kind: 'h2', text: '4. Alur dan state machine' },
  {
    kind: 'p',
    text: 'Status order, pembayaran, refund, payout dan settlement adalah entitas terpisah — jangan menurunkan satu dari yang lain. Setiap transisi ditolak server bila state saat ini tidak cocok (409).',
  },
  { kind: 'h3', text: '4.1 Order' },
  {
    kind: 'code',
    lang: 'text',
    text: [
      'paid_awaiting_tenant -> confirmed -> preparing -> ready_for_pickup -> completed',
      '                     |-> declined      (tenant menolak)',
      '                     |-> cancelled     (lewat keputusan kasus/refund, bukan endpoint tenant)',
    ].join('\n'),
  },
  {
    kind: 'list',
    items: [
      'Order dibuat **sudah dibayar**: wallet didebit di transaksi checkout yang sama. Tidak ada status menunggu pembayaran.',
      'Tenant: `POST /tenants/{tenantId}/orders/{orderId}/confirm|decline|prepare|ready`.',
      'Serah terima: `POST /tenants/{tenantId}/pickup/verification` (cek kode, tanpa efek) lalu `POST /tenants/{tenantId}/pickup/handovers` (menutup order, hanya sekali).',
      'Pembeli memegang kode lewat `GET /orders/{orderId}/pickup-credential`.',
    ],
  },
  { kind: 'h3', text: '4.2 Usulan perubahan jadwal' },
  {
    kind: 'p',
    text: 'Tenant mengusulkan (`POST /tenants/{tenantId}/orders/{orderId}/schedule-proposals`), pembeli memutuskan (`POST /orders/{orderId}/schedule-proposals/{proposalId}/decision`). Timeout atau penolakan **tidak pernah** otomatis menerima usulan atau memulai produksi; tampilkan `expired` sebagai usulan gagal.',
  },
  { kind: 'h3', text: '4.3 Kasus dan refund' },
  {
    kind: 'code',
    lang: 'text',
    text: [
      'kasus : reported -> under_review -> awaiting_information',
      '        -> approved_cancel | declined | resolved   (terminal, sekali)',
      '',
      'approved_cancel = order dibatalkan + refund dibuat (status requested)',
      'refund : requested -> ... -> succeeded | failed | needs_assistance',
      '         saldo pembeli HANYA bertambah saat succeeded',
    ].join('\n'),
  },
  {
    kind: 'p',
    text: 'Keputusan kasus hanya oleh pengelola dengan `campus.cases.decide`; `approved_cancel` juga butuh `campus.refunds.initiate` dan order yang belum di-handover. Kasus setelah pickup tetap bisa diputuskan tetapi tidak memicu refund otomatis.',
  },
  { kind: 'h3', text: '4.4 Payout dan settlement' },
  {
    kind: 'list',
    items: [
      'Order `completed` tanpa kasus terbuka melepas dana ke saldo tersedia tenant (settlement). Ini berbeda dari pembayaran sukses dan berbeda dari order selesai.',
      'Payout: `requested -> processing -> succeeded | failed | cancelled`. Satu payout aktif per tenant.',
      'Rekening bank dikelola owner terverifikasi. Nomor rekening selalu dikembalikan ter-mask; penggantian rekening membuat baris baru.',
      'Verifikasi rekening masih **503 `BANK_ACCOUNT_VERIFICATION_DISABLED`** — jangan bangun alur yang mengandalkannya.',
    ],
  },
  { kind: 'h3', text: '4.5 Ulasan' },
  {
    kind: 'list',
    items: [
      'Satu ulasan per order, hanya untuk order `completed` milik pemanggil dan pembeli dengan email kampus terverifikasi.',
      'Ulasan yang dihapus pembeli tetap menahan order dari ulasan kedua.',
      'Tenant hanya bisa membalas (satu balasan, bisa diperbarui), tidak pernah menghapus.',
      'Moderasi kampus `keep`/`hide` dengan alasan wajib; ulasan `hidden` tidak bisa diedit pembeli.',
    ],
  },
];

export const GUIDE_GAPS: Block[] = [
  { kind: 'h2', text: '5. Belum tersedia — jangan dibangun dulu' },
  {
    kind: 'list',
    items: [
      '**Profil `/me`** (baca/ubah profil, preferensi notifikasi): belum ada endpoint. Data user hanya dari respons verifikasi OTP.',
      '**Antrean risiko/AI** (`risk_signals`, keputusan tinjauan): modul masih scaffold. `campus.ai_reviews.decide` ada di daftar permission tetapi tidak membuka route apa pun.',
      '**Ekspor laporan** (CSV/PDF) dan penjadwalan laporan.',
      '**Provider nyata**: OTP, QRIS, refund bank dan payout semuanya sandbox/stub. Webhook pembayaran hanya menerima event sandbox bertanda tangan.',
      '**Upload file** (foto menu, bukti kasus): belum ada endpoint maupun storage.',
      '**Notifikasi push/email/WhatsApp**: hanya notifikasi dalam aplikasi (`GET /me/notifications`).',
      '**Realtime/WebSocket**: belum ada; polling adalah satu-satunya cara.',
    ],
  },
  {
    kind: 'p',
    text: 'Untuk aksi yang mengubah uang atau status, selalu asumsikan server bisa menolak: tangani 409 dengan memuat ulang resource, jangan mengulang buta.',
  },
];
