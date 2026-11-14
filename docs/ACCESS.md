# Access control

`AccessService` is the server-side authorization boundary for tenant and campus resources. Callers supply the authenticated `userId` from the server principal and the target resource ID; membership, tenant-to-campus relationship, user status, and granted permissions are loaded from PostgreSQL on every check. Do not pass client-supplied roles, scopes, or permission arrays as authority.

## Tenant membership

`tenant_memberships` stores one membership per user and tenant. Supported roles are `owner`, `kitchen`, and `pickup`. An owner row is valid only with `owner_verified_at`; owner creation/verification is a controlled provisioning operation, not a staff-management API. Membership status changes to `revoked` immediately block subsequent checks.

Kitchen and pickup access is the intersection of the role's allowlist and the membership's explicit `permissions`. They can never read tenant finance, manage bank accounts, request payouts, or hand out staff-management access—even if an invalid grant is present in the database. Kitchen staff cannot hand over orders; pickup staff can only receive the explicitly granted order-read, handover, and incident permissions. A verified owner receives the tenant permission set, including finance and payout capabilities.

`grantTenantMembership` and `revokeTenantMembership` require a verified owner with `tenant.staff.manage`, reject self-changes and owner changes, and require a reason. Granting accepts only an explicit permission list within the selected staff role's allowlist; it never grants finance, payout, bank-account, or staff-management permissions. Membership mutation and its `access_audit_events` row commit in one PostgreSQL transaction. If a caller supplies a `PoolClient`, both authorization and mutation use that transaction; authorization takes shared row locks so concurrent membership/user/scope changes wait for the protected transaction to finish. Staff grant serializes on a tenant+subject advisory lock and its upsert refuses to overwrite an owner, including during a bootstrap race. Owner bootstrap must use the same advisory lock when it provisions a membership.

## Campus membership

`campus_memberships` stores explicit campus permissions and has no implicit campus-admin/superuser role. `requireCampus` checks the requested permission against the active membership and verifies that both the user and campus remain active. Initial campus managers and permission changes must come from a controlled bootstrap/provisioning path. No public endpoint grants campus access or broad permissions.

The HTTP surface stays read-only for campus membership: `GET /api/v1/campuses/{campusId}/access` lists the active members of one campus (membership id, user id, display name, permissions, status) and requires `campus.access.manage`. It cannot grant, change or revoke anything. Campus email domains are a separate resource and are managed through `/api/v1/campuses/{campusId}/email-domains` under the same permission; see [modules/campus-access.md](modules/campus-access.md).

## Schema and integration

The Drizzle definitions are in `src/database/schema/access.ts`. The root integrator must export these definitions from the shared schema index and generate/review a migration that includes the append-only database protection in `src/modules/access/access-constraints.sql`. These migration steps are handled by the root integrator. The schema contains membership tables and an access-specific audit record; the general audit module remains independent.

`AccessModule` exports `AccessService` for domain modules and workers. The tenant staff HTTP surface is scoped to:

- `GET /api/v1/tenants/{tenantId}/staff` — list staff membership IDs, roles, explicit permissions, and status.
- `POST /api/v1/tenants/{tenantId}/staff` — grant a kitchen or pickup membership.
- `PUT /api/v1/tenants/{tenantId}/staff/{subjectUserId}` — update that staff membership's role and permissions.
- `DELETE /api/v1/tenants/{tenantId}/staff/{subjectUserId}` — revoke it immediately; a reason is required in the body.

Each route uses the auth guard and validates request DTOs at runtime. The controller derives the actor from the authenticated principal and returns no staff PII. Campus provisioning remains a controlled operation, with no public campus access-management endpoint.

`tenant.settings.manage` (owner only, never assignable to kitchen or pickup staff) guards `PATCH /api/v1/tenants/{tenantId}/settings`, which edits the public stall profile. `campus.risk.read` guards reading the risk queue; deciding on a signal additionally requires `campus.ai_reviews.decide`.
