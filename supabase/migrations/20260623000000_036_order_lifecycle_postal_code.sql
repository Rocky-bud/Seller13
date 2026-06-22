-- Migration 036 · Order lifecycle + postal code (Phase 6 synchronization)
-- ---------------------------------------------------------------------------
-- Additive & idempotent. Safe to re-run.
--
-- Adds the columns the unified merchant-facing fulfilment lifecycle needs:
--   1) postal_code      : the customer's postal code (string).
--   2) tracking_code    : a 24-digit Iran Post tracking/barcode number.
--   3) lifecycle_status : the canonical 4-stage order lifecycle, kept
--                         INDEPENDENT of the payment `status` column so the two
--                         workflows never fight:
--                           pending → ready_to_ship → shipped → completed
--
-- The payment workflow (status: pending_info → awaiting_approval → approved /
-- rejected / cancelled) is left untouched.
-- ---------------------------------------------------------------------------

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS postal_code      text,
  ADD COLUMN IF NOT EXISTS tracking_code    text,
  ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'pending';

-- Constrain the lifecycle to exactly the four supported stages.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_lifecycle_status_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_lifecycle_status_check
      CHECK (lifecycle_status IN ('pending', 'ready_to_ship', 'shipped', 'completed'));
  END IF;
END $$;

-- Enforce the 24-digit format for the post tracking code (NULL until shipped).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_tracking_code_len_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_tracking_code_len_check
      CHECK (tracking_code IS NULL OR tracking_code ~ '^[0-9]{24}$');
  END IF;
END $$;

-- Each post tracking code must be unique across the table (when present).
CREATE UNIQUE INDEX IF NOT EXISTS orders_tracking_code_uniq
  ON public.orders (tracking_code)
  WHERE tracking_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS orders_postal_code_idx ON public.orders (postal_code);
CREATE INDEX IF NOT EXISTS orders_lifecycle_status_idx ON public.orders (lifecycle_status);

-- One-time backfill: derive the canonical lifecycle for existing rows from the
-- legacy payment + shipment columns. Only touches rows still at the default.
UPDATE public.orders SET lifecycle_status =
  CASE
    WHEN shipment_status = 'delivered' THEN 'completed'
    WHEN shipment_status = 'shipped'   THEN 'shipped'
    WHEN status = 'approved'           THEN 'ready_to_ship'
    ELSE 'pending'
  END
WHERE lifecycle_status = 'pending';

COMMENT ON COLUMN public.orders.postal_code      IS 'Customer postal code (string).';
COMMENT ON COLUMN public.orders.tracking_code    IS '24-digit Iran Post tracking/barcode number.';
COMMENT ON COLUMN public.orders.lifecycle_status IS 'Canonical order lifecycle: pending | ready_to_ship | shipped | completed.';
