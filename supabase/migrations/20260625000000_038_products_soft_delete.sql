-- ════════════════════════════════════════════════════════════════════════════
-- Migration 038 · Soft-delete for products (FK deadlock fix)
-- ════════════════════════════════════════════════════════════════════════════
-- ROOT CAUSE
--   Migration 014 defines:
--     orders.product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT
--   So the moment a product appears in ANY historical order, a hard DELETE on
--   that product row raises a foreign-key violation (23503). The merchant
--   dashboard's "حذف محصول" button therefore always failed in production.
--
-- STRUCTURAL FIX
--   Pivot to a soft-delete pattern. The product row is preserved forever (so
--   the FK from orders stays valid and past invoices keep their product name /
--   price), but it is flagged is_deleted = true and hidden from every merchant
--   and buyer catalog query. Deletion becomes a metadata update, never a
--   physical row removal.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Partial index keeps the hot "live catalog" reads (WHERE is_deleted = false)
-- fast even after thousands of products have been archived over time.
CREATE INDEX IF NOT EXISTS idx_products_shop_active
  ON products (shop_id)
  WHERE is_deleted = false;

-- Backfill is implicit: NOT NULL DEFAULT false sets every existing row to
-- "live", so nothing disappears from current catalogs when this migration runs.
