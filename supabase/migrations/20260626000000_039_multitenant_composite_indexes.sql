-- ──────────────────────────────────────────────────────────────
-- Migration 039 · Enterprise multi-tenant composite indexing guard (Phase 4 · #6)
--
-- Every customer-facing lookup is scoped by shop_id (the tenant key). To keep
-- query latency flat as the platform grows toward millions of shops, this
-- migration adds composite B-tree indexes whose LEADING column is always
-- shop_id, so Postgres can prune to a single tenant's slice before filtering on
-- the secondary predicate. These mirror the exact (shop_id, ...) filters used by
-- the storefront, bot, inline-search and dashboard routes.
--
-- All statements are idempotent (IF NOT EXISTS) so the migration is safe to
-- re-run. Note: migration 038 already created the partial active-products index
-- (idx_products_shop_active ON products(shop_id) WHERE is_deleted = false); the
-- composite below complements it for queries that also read archived rows.
-- ──────────────────────────────────────────────────────────────

BEGIN;

-- products: tenant-scoped catalog reads, with the soft-delete flag co-indexed so
-- `WHERE shop_id = ? AND is_deleted = false` is a pure index scan.
CREATE INDEX IF NOT EXISTS idx_products_shop_deleted
  ON products (shop_id, is_deleted);

-- orders: tenant-scoped status boards (pending_info / pending_receipt / etc.)
-- used by the dashboard + checkout reconciliation.
CREATE INDEX IF NOT EXISTS idx_orders_shop_status
  ON orders (shop_id, status);

-- orders: per-buyer history within a tenant (cart rebuilds, tracking, the bot's
-- pending_info lookups all filter on shop_id + user_id).
CREATE INDEX IF NOT EXISTS idx_orders_shop_user
  ON orders (shop_id, user_id);

-- orders: tenant-scoped chronological lists (recent orders, analytics windows).
CREATE INDEX IF NOT EXISTS idx_orders_shop_created
  ON orders (shop_id, created_at DESC);

COMMIT;
