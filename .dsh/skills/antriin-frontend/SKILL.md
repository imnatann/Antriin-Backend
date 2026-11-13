---
name: antriin-frontend
description: >
  Build or modify the Antriin frontend against the real backend contract.
  Use whenever the task touches Antriin screens, API calls, types, money
  formatting, auth/session, tenant or campus dashboards, order status, wallet,
  payouts, reviews or moderation. It pins the contract to the running API so the
  UI cannot drift from what the server actually accepts.
argument-hint: '[screen|api|types|auth|money|states]'
license: UNLICENSED
---

# Antriin Frontend

The backend is the source of truth. Every rule below is enforced server-side, so a UI that disagrees with it produces 400/403/409 that users will see.

## 1. Read the contract before writing any code

The API guide is generated from the live OpenAPI document, so it cannot be stale. Fetch it once per session, do not guess endpoint shapes from memory:

```sh
curl -s http://127.0.0.1:3000/api/v1/guide.md > /tmp/antriin-api.md
wc -l /tmp/antriin-api.md
```

- `/api/v1/guide.md` — Markdown, cheapest to read (endpoints, objects, all constraints)
- `/api/v1/guide` — same content as a styled HTML page
- `/api/v1/guide/openapi.json` — raw OpenAPI, use this to generate types

**Never hand-write request/response types.** Generate them from `openapi.json` (`openapi-typescript` or equivalent). If a type is missing, the endpoint is missing — see `7.

Repo reference: [docs/modules/api-guide.md](../../../docs/modules/api-guide.md).

## 2. Base URL and envelope

- Base: `/api/v1` (local `http://localhost:3000/api/v1`).
- Success: `{ data }` for one object, `{ data, meta }` for lists.
- Error: `{ error: { code, message, details?, request_id, retry_after_seconds? } }`.
- **Branch on `error.code`, never on `error.message`** — message is for humans and may change.
- Send `error.request_id` (same as header `x-request-id`) in every bug report and in your own logging.

## 3. Money is a string, always

Server sends `"amountMinor": "25000"` with `currency`. Whole rupiah, no decimals.

- Type it as `string`. Never `number`.
- Never `parseFloat` / `Number()` / arithmetic with `+` for money.
- Format for display: `new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(BigInt(amountMinor))`
- If you must compute (totals, remaining balance), use `BigInt` and convert back to string.

## 4. Timestamps are microsecond UTC strings

Format is `YYYY-MM-DDTHH:MM:SS.ffffffZ`.

- Treat them as opaque strings for transport.
- **Never** do `new Date(x).toISOString()` and send it back — that truncates to milliseconds and breaks optimistic concurrency (the server compares the exact string, so you get a spurious 409).
- Convert to `Date` only at the render edge. Use the resource's own timezone field (IANA) for display, never the browser default.

## 5. Auth

- OTP login, no password. `POST /auth/otp-challenges` → `POST /auth/otp-challenges/{id}/verify` → returns `sessionToken` **once**.
- Token is opaque, not a JWT. Do not try to decode it or read claims from it. **There is no "current user" endpoint yet** — keep the `user` object from the verify response in your own session state.
- Send `Authorization: Bearer <token>`.
- Store in httpOnly cookie via a BFF, or in memory + refresh. Do not use localStorage.
- `POST /auth/sessions/refresh` rotates: the old token dies immediately, so persist the new one before continuing.
- `DELETE /auth/sessions/current` on logout.
- Campus verification is **separate** from login (`/auth/campus-email-verifications`). Gate review-writing UI on `GET /auth/campus-email-verifications/current`.
- OTP delivery returns **503** in development (no real provider). Do not treat 503 as "wrong code".

## 6. Permissions decide which UI exists

The server checks session → active membership → permission → resource scope. Hiding a button is a UX nicety; the server still enforces.

Tenant roles (`owner` / `kitchen` / `pickup`):

- `owner` needs `owner_verified_at` set, otherwise **all** tenant access is 403.
- `kitchen`: orders read/accept/prepare/pause, menu, capacity, reviews reply, incidents.
- `pickup`: orders read, handover, incidents only.
- Finance (`tenant.finance.read`, bank account, payout) is **owner-only**. Never render bank/payout screens for kitchen or pickup staff — it is a 403, not a hidden feature.

Campus permissions are listed in the guide `3.2.

A resource owned by someone else answers **404, not 403** — that is deliberate. Do not build "you are not allowed" screens off a 404; treat it as not-found.

## 7. What does not exist — do not build it

Building UI for these produces dead screens:

- **`/me` profile** (read/update profile, notification preferences) — no endpoint.
- **Risk / AI review queue** — backend module is still a scaffold. `campus.ai_reviews.decide` is a permission with no route.
- **Report export** (CSV/PDF) and scheduled reports.
- **File upload** (menu photos, case evidence) — no endpoint, no storage.
- **Push / email / WhatsApp notifications** — in-app only (`GET /me/notifications`).
- **Realtime / WebSocket** — none. Poll.
- **Real payment providers** — QRIS, refund and payout are sandbox/stub.

If a screen needs one of these, stop and ask. Do not mock it into looking done.

## 8. State is a state machine, not a boolean

Never invent a status or derive one status from another. Order, payment, refund, payout and settlement are independent entities.

- Order: `paid_awaiting_tenant → confirmed → preparing → ready_for_pickup → completed`, with `declined` / `cancelled` branches.
- Orders are created **already paid** — there is no "awaiting payment" screen for orders.
- Schedule proposals: timeout/rejection **never** auto-accepts. Render `expired` as failed.
- Refund credits the wallet only at `succeeded`. `processing` is not success.
- Settlement ≠ order completed ≠ payment succeeded.

## 9. Idempotency and retries

- `POST /orders` **requires** header `Idempotency-Key` (8–200 chars, `A-Z a-z 0-9 . _ :`). Generate once per user action, reuse on network retry.
- `POST /wallet/topups` takes `idempotencyKey` **in the body**.
- Same key + same payload = replay, no new effect. Same key + different payload = 409.
- On 409 for a mutation: **reload the resource**, do not blind-retry.
- On 503: show a pending state. Never auto-retry a mutation that moves money without the same idempotency key.

## 10. Before you say it is done

- [ ] Types generated from `openapi.json`, not hand-written.
- [ ] No `number` type anywhere a money field flows.
- [ ] No `toISOString()` sent back to the server.
- [ ] Every error path branches on `error.code`.
- [ ] Every mutation that can 409 has a reload path.
- [ ] No screen built for anything in `7.
- [ ] Role-gated screens match the matrix in `6.

## When the backend and the guide disagree

They cannot, by construction — the guide is generated from the running document. If the guide lacks an endpoint you believe exists, it does not exist. Ask; do not invent a call.
