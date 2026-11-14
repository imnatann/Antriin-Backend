# Modul Risk (antrean sinyal dan keputusan manusia)

Antrean sinyal risiko/AI untuk pengelola kampus. Modul ini menutup REQUIREMENTS §3.10.4–3.10.6 tanpa melanggar aturan produk yang paling mudah dilanggar: **skor tidak pernah menjadi sanksi otomatis**.

## Prinsip yang dikunci di schema

| Aturan                                                    | Cara ditegakkan                                                                                                 |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Sinyal adalah bukti, bukan sanksi                         | Tidak ada kolom status dan tidak ada endpoint yang memblokir akun, menyembunyikan ulasan, atau memindahkan uang |
| Sinyal tidak dapat diubah atau dihapus                    | Tabel `risk_signals` tanpa `updated_at`; tidak ada route `PATCH`/`DELETE`                                       |
| Riwayat keputusan utuh                                    | `risk_review_decisions` append-only; keputusan terbaru = status saat ini                                        |
| Sinyal tidak dapat diduplikasi oleh detektor yang diulang | `UNIQUE (dedupe_key)` + `INSERT … ON CONFLICT DO NOTHING`                                                       |
| Skor wajib berada di 0..1                                 | `CHECK` pada `risk_signals.score`                                                                               |

## Endpoint

| Method | Path                                                         | Permission                 |
| ------ | ------------------------------------------------------------ | -------------------------- |
| GET    | `/api/v1/campuses/:campusId/risk-reviews`                    | `campus.risk.read`         |
| GET    | `/api/v1/campuses/:campusId/risk-reviews/:signalId`          | `campus.risk.read`         |
| POST   | `/api/v1/campuses/:campusId/risk-reviews/:signalId/decision` | `campus.ai_reviews.decide` |

Membaca antrean dan memutuskan adalah dua permission terpisah: analis boleh meninjau tanpa boleh mencatat keputusan.

## Antrean

`state` default `pending` — sinyal yang **belum punya baris keputusan sama sekali**. Karena keputusan bersifat append-only dan tidak pernah dibatalkan, "pending" adalah definisi yang tidak bisa basi:

| `state`   | Arti                                       |
| --------- | ------------------------------------------ |
| `pending` | Tidak ada baris di `risk_review_decisions` |
| `decided` | Ada minimal satu keputusan                 |
| `all`     | Semua sinyal kampus                        |

Filter `category` opsional (`rating_anomaly`, `payment_refund_chain`, `tenant_status_change`). Pagination memakai cursor `(occurred_at, id)` menurun; `limit` default 25, maksimum 100. Semua query di-scope `campus_id = :campusId`; sinyal kampus lain dijawab **404**.

```json
{
  "data": [
    {
      "id": "…",
      "campusId": "…",
      "tenantId": "…",
      "subjectType": "tenant",
      "subjectId": "…",
      "category": "rating_anomaly",
      "score": "0.8700",
      "modelVersion": "heuristic-v1",
      "explanation": "Rating bergerak dari 3.5 ke 4.9 dalam 30 ulasan / 5 menit",
      "evidence": { "…": "…" },
      "occurredAt": "2026-11-13T10:00:00.000000Z",
      "decision": null
    }
  ],
  "meta": { "next_cursor": null }
}
```

Detail satu sinyal (`GET …/:signalId`) menambahkan `decisions: [...]` berisi seluruh riwayat, terbaru lebih dulu.

## Keputusan

```json
{ "decision": "no_violation", "reason": "Pemilik menjelaskan lonjakan berasal dari acara kampus" }
}
```

- `decision` hanya `no_violation` atau `explanation_requested`. Keduanya **tidak** mengubah data tenant, order, saldo, atau ulasan — hanya mencatat hasil tinjauan manusia.
- `reason` wajib (1–500 karakter) dan disimpan apa adanya.
- Keputusan dapat dicatat ulang; baris lama tidak dihapus sehingga riwayatnya lengkap. Ini sesuai §3.10.6 ("Riwayat keputusan dapat dibaca sesuai izin").
- Transaksi mengambil `SELECT … FOR UPDATE` pada baris sinyal agar dua keputusan bersamaan tidak menghasilkan urutan yang membingungkan.
- Setiap keputusan menulis `audit_events` (`campus.risk_review_decided`) dengan `decision` dan `category` di metadata.

## Produsen sinyal

`RiskService.ingestSignal()` tersedia untuk job/worker di masa depan dan **tidak** diekspos sebagai route HTTP:

```ts
ingestSignal({ campusId, tenantId?, subjectType, subjectId, category, score, modelVersion, explanation, evidence?, dedupeKey })
}
```

Idempoten lewat `dedupe_key`: pemanggilan ulang detektor yang sama mengembalikan `{ created: false, signalId }` tanpa baris baru.

## Yang sengaja belum ada

- **Detektor otomatis.** Belum ada job yang memindai lonjakan rating atau rantai top-up→pembayaran→refund dan menulis sinyal. Tabel dan antreannya sudah siap; pemicunya belum.
- **Sanksi dan tindak lanjut.** Tidak akan ditambahkan tanpa keputusan produk eksplisit: REQUIREMENTS §3.10.5 melarang skor menjadi dasar sanksi otomatis.
- **Menutup sinyal.** Karena keputusan append-only, sinyal selalu punya jejak; "menutup" berarti mencatat keputusan baru, bukan menghapus.
