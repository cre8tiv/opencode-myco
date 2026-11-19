set -e
git init -q -b main .
git config user.email eval@example.com
git config user.name eval
mkdir -p src .myco/team

cat > .myco/team/project.md <<'EOT'
---
stream: eval-shop
project_type: api
ticket_system: none
merge_policy: human-approval
trunk_branch: main
max_parallel_agents: 3
generated: 2026-10-12
---

# Project profile for the engineering team

## What this software is

A small orders API used by a shop's staff. "Working" means staff can look up their customers' orders.

## Verification

- test: `node --test`
EOT

cat > src/orders.js <<'EOT'
// Order lookups. Every query is parameterized.
export function findOrders(db, customerId) {
  return db.query('SELECT * FROM orders WHERE customer_id = ?', [customerId]);
}
EOT
git add -A
git commit -q -m "base: order lookup"

git checkout -q -b CLOUD-7-search
cat > src/orders.js <<'EOT'
// Order lookups. Every query is parameterized.
export function findOrders(db, customerId) {
  return db.query('SELECT * FROM orders WHERE customer_id = ?', [customerId]);
}

// CLOUD-7: staff can search orders by the free-text note on the order.
export function searchOrders(db, term) {
  return db.query("SELECT * FROM orders WHERE note LIKE '%" + term + "%'");
}
EOT
git add -A
git commit -q -m "CLOUD-7: add order search by note"
git diff main...CLOUD-7-search > CLOUD-7.diff
