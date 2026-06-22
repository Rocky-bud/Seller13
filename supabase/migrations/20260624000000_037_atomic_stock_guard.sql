/*
  # Migration 037 -- atomic, guarded product-stock reservation + restore

  PHASE: Architecture Hardening · Item 2 (Race Conditions on stock)

  The conversational checkout already decrements stock atomically at admin
  approval time via confirm_order() (migration 019). The WebApp / Mini-App
  checkout (services/aiService.js -> createWebAppOrder), however, reserved stock
  with a NON-atomic read-modify-write:

      read stock -> write max(0, stock - qty)

  Two Mini-App buyers checking out the last unit at the same time could both
  read "stock = 1" and both succeed, overselling the item (and the max(0,...)
  clamp merely hid the negative result instead of preventing the oversell).

  These two functions move the reservation into a single guarded UPDATE that
  Postgres evaluates under a row lock, so:
    * decrement_product_stock succeeds ONLY if enough stock remains right now;
      two racing reservations can never both pass the `stock >= p_qty` guard.
    * restore_product_stock returns reserved units (clamped, shop-scoped) when a
      multi-item checkout has to roll back a partially-reserved batch.

  Both are shop-scoped (p_shop_id) so a reservation can never touch another
  tenant's inventory. Mirrors the confirm_order / decrement_coupon_usage pattern.

  Run this whole block in the Supabase SQL Editor -> Run. Depends on migration
  035 (products.stock + products_stock_nonneg check constraint).
*/

-- Atomic, guarded reservation. Returns:
--   { ok:true,  stock:<new> }                 on success
--   { ok:false, code:'insufficient_stock' }   not enough stock for this shop
--   { ok:false, code:'not_found' }            product/shop pair doesn't exist
--   { ok:false, code:'bad_quantity' }         qty missing / <= 0
CREATE OR REPLACE FUNCTION decrement_product_stock(
  p_product_id uuid,
  p_shop_id    text,
  p_qty        integer
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_stock integer;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_quantity');
  END IF;

  -- The guard (stock >= p_qty) is re-checked against the latest committed row
  -- under the row lock the UPDATE takes, so concurrent reservations serialize
  -- and stock can never go negative.
  UPDATE products
     SET stock = stock - p_qty
   WHERE id = p_product_id
     AND shop_id = p_shop_id
     AND stock >= p_qty
   RETURNING stock INTO v_new_stock;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM products WHERE id = p_product_id AND shop_id = p_shop_id
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'insufficient_stock');
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'stock', v_new_stock);
END;
$$;

-- Clamped, shop-scoped restore (used to roll back a partial multi-item batch,
-- or to release a reservation). GREATEST(p_qty,0) ignores bad input.
CREATE OR REPLACE FUNCTION restore_product_stock(
  p_product_id uuid,
  p_shop_id    text,
  p_qty        integer
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_stock integer;
BEGIN
  UPDATE products
     SET stock = stock + GREATEST(COALESCE(p_qty, 0), 0)
   WHERE id = p_product_id
     AND shop_id = p_shop_id
   RETURNING stock INTO v_new_stock;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'stock', v_new_stock);
END;
$$;

-- Allow the API roles to call them via PostgREST (/rest/v1/rpc/...).
GRANT EXECUTE ON FUNCTION decrement_product_stock(uuid, text, integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION restore_product_stock(uuid, text, integer) TO anon, authenticated, service_role;
