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
EOT

cat > docs/design/order-export/README.md <<'EOT'
# Order export

| | |
| --- | --- |
| **Status** | Drafting |

| Document | Author | Status | Open questions |
| --- | --- | --- | --- |
| [PRD](prd.md) | product-lead | Decided | 0 |
| [Architecture](architecture.md) | architect | Not started | |
EOT

cat > docs/design/order-export/prd.md <<'EOT'
| | |
| --- | --- |
| **Status** | Decided |

## 1. Problem

Tenant admins cannot get their own order history out of Northwind in bulk.

## 4. Actors

| ID | Actor | Kind | Context | Need | Identity & permissions |
| --- | --- | --- | --- | --- | --- |
| A-1 | Tenant admin | human | month end, web app | download their tenant's orders | SSO login, tenant-scoped admin role |

## 7. Functional requirements

| ID | Requirement | Actor | Priority |
| --- | --- | --- | --- |
| EXP-1 | A tenant admin can export their tenant's orders as CSV | A-1 | P0 |
EOT

git add -A
git commit -q -m "order export package: PRD only"
