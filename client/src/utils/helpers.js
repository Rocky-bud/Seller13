export function formatToman(amount) {
  return Number(amount || 0).toLocaleString('fa-IR') + ' تومان';
}

export function formatDate(dateStr) {
  if (!dateStr) return '---';
  const d = new Date(dateStr);
  return d.toLocaleDateString('fa-IR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Order status dictionary. Keys are the raw DB strings; StatusBadge lowercases
// the value before lookup so casing/spelling variants never leak to the UI.
export const statusLabels = {
  pending_info: 'در انتظار تکمیل مشخصات',
  pending_receipt: 'در انتظار رسید',
  awaiting_approval: 'در انتظار تأیید',
  approved: 'تأیید شده',
  rejected: 'رد شده',
  cancelled: 'لغو شده',
  canceled: 'لغو شده'
};

export const statusColors = {
  pending_info: 'bg-slate-100 text-slate-600 border-slate-300',
  pending_receipt: 'bg-warning-50 text-warning-600 border-warning-500',
  awaiting_approval: 'bg-primary-50 text-primary-700 border-primary-500',
  approved: 'bg-success-50 text-success-600 border-success-500',
  rejected: 'bg-danger-50 text-danger-600 border-danger-500',
  cancelled: 'bg-slate-200 text-slate-600 border-slate-400',
  canceled: 'bg-slate-200 text-slate-600 border-slate-400'
};

// Phase 5 Step 1 -- shipment lifecycle labels + colors (packed -> shipped -> delivered)
export const shipmentLabels = {
  packed: 'در حال بسته‌بندی',
  shipped: 'ارسال شده',
  delivered: 'تحویل داده شد'
};

export const shipmentColors = {
  packed: 'bg-warning-50 text-warning-600 border-warning-500',
  shipped: 'bg-primary-50 text-primary-700 border-primary-500',
  delivered: 'bg-success-50 text-success-600 border-success-500'
};

// PART 2 -- unified order fulfillment lifecycle, stored in orders.lifecycle_status
// (migration 036): pending -> ready_to_ship -> shipped -> completed.
export const lifecycleLabels = {
  pending: 'در انتظار پرداخت',
  ready_to_ship: 'آماده ارسال',
  shipped: 'ارسال شده',
  completed: 'تحویل شده'
};

export const lifecycleColors = {
  pending: 'bg-warning-50 text-warning-600 border-warning-500',
  ready_to_ship: 'bg-sky-50 text-sky-700 border-sky-500',
  shipped: 'bg-primary-50 text-primary-700 border-primary-500',
  completed: 'bg-success-50 text-success-600 border-success-500'
};

// Canonical order of the fulfillment lifecycle (used to gate forward-only
// transitions in the dashboard).
export const LIFECYCLE_ORDER = ['pending', 'ready_to_ship', 'shipped', 'completed'];
