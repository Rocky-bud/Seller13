// services/orderLifecycle.js
// ───────────────────────────────────────────────────────────────────────────
// Canonical, application-level ORDER LIFECYCLE (Phase 6 synchronization).
//
// The persisted `orders` schema keeps TWO orthogonal workflow columns so the
// battle-tested payment flow is never rewritten:
//   • orders.status          — payment workflow
//                              (pending_info → awaiting_approval → approved
//                               / rejected / cancelled)
//   • orders.shipment_status — fulfilment workflow (packed → shipped → delivered)
//
// The merchant/customer UX, however, is described with FOUR simple stages.
// This module is the SINGLE SOURCE OF TRUTH that maps the stored columns onto
// those four canonical stages and back, so the dashboard and the bot speak the
// same language without diverging from the storage model.
// ───────────────────────────────────────────────────────────────────────────

export const ORDER_LIFECYCLE = Object.freeze({
  PENDING: 'pending',            // initial order / shop card details sent to customer
  READY_TO_SHIP: 'ready_to_ship', // paid + approved, awaiting dispatch by the merchant
  SHIPPED: 'shipped',            // tracking code added by the merchant
  COMPLETED: 'completed',        // delivered to the customer
});

// Ordered list (forward progression) of the canonical stages.
export const LIFECYCLE_ORDER = [
  ORDER_LIFECYCLE.PENDING,
  ORDER_LIFECYCLE.READY_TO_SHIP,
  ORDER_LIFECYCLE.SHIPPED,
  ORDER_LIFECYCLE.COMPLETED,
];

// Persian, customer/merchant-facing labels for each canonical stage.
export const LIFECYCLE_LABELS_FA = Object.freeze({
  pending: 'در انتظار پرداخت',
  ready_to_ship: 'آماده ارسال',
  shipped: 'ارسال‌شده',
  completed: 'تکمیل‌شده',
  rejected: 'رد شده',
  cancelled: 'لغو شده',
});

export function isLifecycleStatus(value) {
  return LIFECYCLE_ORDER.includes(value);
}

// ── Post tracking code (24-digit Iran Post barcode) ─────────────────────────
export const TRACKING_CODE_LENGTH = 24;
const TRACKING_CODE_RE = /^\d{24}$/;

// Fold Persian (U+06F0–U+06F9) and Arabic-Indic (U+0660–U+0669) digits to ASCII
// then strip every non-digit. Keeps merchant copy/paste robust.
export function foldDigits(raw) {
  if (raw == null) return '';
  return String(raw)
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

export function normalizeTrackingCode(raw) {
  return foldDigits(raw).replace(/\D/g, '');
}

export function isValidTrackingCode(raw) {
  return TRACKING_CODE_RE.test(normalizeTrackingCode(raw));
}

// Iran postal codes are 10 digits; we accept 5–12 digits to stay permissive.
export function normalizePostalCode(raw) {
  return normalizeTrackingCode(raw);
}

export function isValidPostalCode(raw) {
  const s = normalizePostalCode(raw);
  return s.length >= 5 && s.length <= 12;
}

// Derive the canonical lifecycle stage from a stored order row.
export function deriveLifecycle(order = {}) {
  const status = order.status || '';
  const shipment = order.shipment_status || '';
  // Terminal payment outcomes surface as-is (no shipment progression).
  if (status === 'rejected' || status === 'cancelled') return status;
  if (shipment === 'delivered' || status === 'completed') return ORDER_LIFECYCLE.COMPLETED;
  if (shipment === 'shipped' || status === 'shipped') return ORDER_LIFECYCLE.SHIPPED;
  if (status === 'approved') return ORDER_LIFECYCLE.READY_TO_SHIP;
  return ORDER_LIFECYCLE.PENDING;
}

// Map a requested canonical lifecycle stage to the concrete column writes that
// keep BOTH workflow columns coherent. Returns null for an unknown stage.
// The 24-digit code is written to BOTH `tracking_code` (the canonical post
// code) and `postal_tracking_code` (legacy column) for full compatibility.
export function lifecycleToPatch(stage, { trackingCode = null, postalCode = null } = {}) {
  const now = new Date().toISOString();
  switch (stage) {
    case ORDER_LIFECYCLE.PENDING:
      return { status: 'pending_info', shipment_status: null };
    case ORDER_LIFECYCLE.READY_TO_SHIP:
      return { status: 'approved', shipment_status: 'packed' };
    case ORDER_LIFECYCLE.SHIPPED: {
      const patch = { shipment_status: 'shipped', shipped_at: now };
      if (trackingCode) {
        patch.tracking_code = trackingCode;
        patch.postal_tracking_code = trackingCode;
      }
      if (postalCode) patch.postal_code = postalCode;
      return patch;
    }
    case ORDER_LIFECYCLE.COMPLETED:
      return { shipment_status: 'delivered', delivered_at: now };
    default:
      return null;
  }
}

// The legal forward transitions for the manual merchant fulfilment actions.
export const LIFECYCLE_NEXT = Object.freeze({
  pending: ['ready_to_ship'],
  ready_to_ship: ['shipped'],
  shipped: ['completed'],
  completed: [],
});

export default {
  ORDER_LIFECYCLE,
  LIFECYCLE_ORDER,
  LIFECYCLE_LABELS_FA,
  LIFECYCLE_NEXT,
  TRACKING_CODE_LENGTH,
  isLifecycleStatus,
  isValidTrackingCode,
  normalizeTrackingCode,
  isValidPostalCode,
  normalizePostalCode,
  foldDigits,
  deriveLifecycle,
  lifecycleToPatch,
};
