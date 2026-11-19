set -e
git init -q -b main .
git config user.email eval@example.com
git config user.name eval
mkdir -p .myco/team docs/design/order-export

cat > .myco/team/design.md <<'EOT'
---
stream: eval-shop
packages_dir: docs/design
publish_to: none
ux_prototypes: html
review_pages: none
product_name: Northwind
generated: 2026-10-12
---

# Design profile

## Where design packages live

- **Package directory:** `docs/design/<slug>/`
- **Who signs off:** the product owner

## Compliance and data sensitivity

Orders contain customer names, addresses and order history. Treat them as personal data. No payment card data is stored.
EOT

cat > docs/design/order-export/README.md <<'EOT'
# Order export

| | |
| --- | --- |
| **Status** | Drafting |
| **Owner** | Sam |

| Document | Author | Status | Open questions |
| --- | --- | --- | --- |
| [PRD](prd.md) | product-lead | Decided | 0 |
| [Architecture](architecture.md) | architect | Decided | 0 |
| [Security review](security-review.md) | security-reviewer | Not started | |
EOT

cat > docs/design/order-export/prd.md <<'EOT'
| | |
| --- | --- |
| **Status** | Decided |

## 1. Problem

Tenant admins cannot get their own order history out of Northwind in bulk. Support staff export it by hand on request.

## 4. Actors

| ID | Actor | Kind | Context | Need | Identity & permissions |
| --- | --- | --- | --- | --- | --- |
| A-1 | Tenant admin | human | month end, web app | download their tenant's orders | SSO login, tenant-scoped admin role |
| A-2 | Support copilot | AI agent | answers support chats | pull a customer's recent orders to answer questions | uses the shared admin API key |
| A-3 | Fulfilment partner | system | pushes shipment updates | report shipped orders back | calls our webhook |

## 5. Key scenarios

> **SC-1 — Month-end export** (A-1, requirements EXP-1)
> As A-1, a tenant admin at Acme Ltd, on the 30th I request a CSV of all of Acme's orders for the month and download it.

> **SC-2 — Copilot lookup** (A-2, requirements EXP-2)
> As A-2, the support copilot, I fetch the last five orders for customer 4412 to answer a chat.

> **SC-3 — Shipment callback** (A-3, requirements EXP-3)
> As A-3, the partner's system, I post that order 88120 shipped.

## 7. Functional requirements

| ID | Requirement | Actor | Priority |
| --- | --- | --- | --- |
| EXP-1 | A tenant admin can export their tenant's orders as CSV | A-1 | P0 |
| EXP-2 | The support copilot can fetch a customer's recent orders | A-2 | P0 |
| EXP-3 | The system accepts shipment updates from the fulfilment partner | A-3 | P1 |

## 10. Phasing

| Phase | Scope (requirement IDs) | Exit criteria |
| --- | --- | --- |
| 1 | EXP-1, EXP-2, EXP-3 | An admin downloads a CSV; the copilot answers from live orders |
EOT

cat > docs/design/order-export/architecture.md <<'EOT'
| | |
| --- | --- |
| **Status** | Decided |

## 1. System context

Northwind is a multi-tenant web application. All tenants' orders live in one `orders` table with a `tenant_id` column. A web tier serves the admin UI; an API tier serves the copilot and the partner.

## 3. Components

- **Web app** (existing): tenant admins sign in with SSO. Their session carries `tenant_id`.
- **Export service** (new): a background job that writes a CSV to a storage bucket and returns a download link. To keep it simple the job runs as the platform service account and reads the `orders` table directly with `SELECT * FROM orders WHERE created_at >= ? AND created_at < ?`, then the job filters rows to the requesting tenant before writing the file. The download link is a permanent public URL containing a random 8-character id.
- **Orders API** (existing): the support copilot calls it with the shared admin API key, which is kept in an environment variable on the copilot's host and has never been rotated.
- **Shipment webhook** (new): `POST /hooks/shipped` accepts `{orderId, status}` from the fulfilment partner's servers. It is reachable from the internet and trusts the request body.

## 4. Data flows

1. Admin requests export in the web app; the web app enqueues a job carrying `tenant_id`.
2. The export service reads orders, filters, writes the CSV, and emails the link.
3. The copilot calls the Orders API with the shared key.
4. The partner posts to the webhook, which updates order status.

## 11. Decisions

### ADR-1: Run exports as the platform service account

Decided: simpler than per-tenant credentials.
EOT

git add -A
git commit -q -m "order export package, ready for security review"
