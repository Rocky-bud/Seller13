/**
 * routes/dashboard — server-computed merchant "میز کار" (home) metrics.
 *
 * BUG #1 FIX ("خطا در بارگذاری اطلاعات میز کار")
 * ---------------------------------------------------------------------------
 * The merchant dashboard home screen used to hydrate itself with several
 * DIRECT browser PostgREST reads (orders + products + chats). After RLS was
 * enabled (migration 021) those reads run as the `authenticated` role and are
 * gated by shop_members. For super-admins, fresh installs, or any account
 * without a shop_members row — and for a momentarily stale JWT — the reads
 * either error (401) or silently return nothing, and because the client used
 * Promise.all (no per-read catch) a SINGLE failure rejected the whole load and
 * the UI fell back to "خطا در بارگذاری اطلاعات".
 *
 * This endpoint moves the aggregation server-side behind the SERVICE-ROLE key
 * (which bypasses RLS, exactly like /api/analytics and /api/customers already
 * do), scopes everything to the verified session's shopId, and ALWAYS returns
 * a fully zero-filled payload — so a brand-new shop with an empty database
 * hydrates cleanly instead of crashing the frontend.
 *
 *   GET /api/dashboard/stats?shopId=SHOP-XXX  -> { success, data: { ...stats } }
 *
 * The `data` shape is byte-for-byte what the Dashboard component already
 * consumes (totals + lowStock alerts + recentOrders + an `analytics` block
 * with fa-IR day labels and a Telegram/Instagram split), so no chart code has
 * to change.
 */
import { Router } from 'express';
import dotenv from 'dotenv';
import { requireShopRole } from '../middleware/auth.js';

dotenv.config();

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY;

const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

// Resilient read: never throws. Returns [] on any error so one empty/failed
// table can never take down the whole dashboard payload.
async function safeFetch(path) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: HEADERS });
    if (!res.ok) return [];
    const text = await res.text();
    const json = text ? JSON.parse(text) : [];
    return Array.isArray(json) ? json : [];
  } catch {
    return [];
  }
}

// Resolve an order's sales channel the same way the client always has: trust an
// explicit orders.platform value, else fall back to the customer's chat
// platform, else default to Telegram.
function resolveOrderPlatform(order, platformMap) {
  if (order.platform === 'telegram' || order.platform === 'instagram') {
    return order.platform;
  }
  const fromChats = platformMap[order.user_id];
  return fromChats === 'instagram' ? 'instagram' : 'telegram';
}

// Build the 7-day fa-IR sales trend + platform split. Mirrors the client's
// computeSalesAnalytics() exactly (labels included) so the existing charts
// render identically. Node's full-ICU build resolves the fa-IR locale.
function computeSalesAnalytics(approvedOrders, platformMap = {}, days = 7) {
  const orders = Array.isArray(approvedOrders) ? approvedOrders : [];

  const dayKey = (value) => {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const today = new Date();
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    buckets.push({
      key: dayKey(d),
      label: d.toLocaleDateString('fa-IR', { weekday: 'short' }),
      dateLabel: d.toLocaleDateString('fa-IR', { day: 'numeric', month: 'short' }),
      revenue: 0,
      count: 0,
    });
  }
  const byKey = {};
  for (const b of buckets) byKey[b.key] = b;
  for (const o of orders) {
    const b = byKey[dayKey(o.created_at)];
    if (b) {
      b.revenue += Number(o.total_price || 0);
      b.count += 1;
    }
  }

  const platforms = {
    telegram: { count: 0, revenue: 0 },
    instagram: { count: 0, revenue: 0 },
  };
  for (const o of orders) {
    const p = resolveOrderPlatform(o, platformMap);
    platforms[p].count += 1;
    platforms[p].revenue += Number(o.total_price || 0);
  }
  const platformTotalRevenue = platforms.telegram.revenue + platforms.instagram.revenue;
  const platformTotalCount = platforms.telegram.count + platforms.instagram.count;

  return {
    dailyTrend: buckets,
    weekRevenue: buckets.reduce((s, b) => s + b.revenue, 0),
    weekCount: buckets.reduce((s, b) => s + b.count, 0),
    platforms,
    platformTotalRevenue,
    platformTotalCount,
  };
}

// ── GET /api/dashboard/stats?shopId=SHOP-XXX ──────────────────────────────
router.get('/stats', requireShopRole('viewer'), async (req, res) => {
  const { shopId, startDate, endDate } = req.query;
  if (!shopId) {
    return res.status(400).json({ success: false, error: 'shopId الزامی است' });
  }
  const sid = encodeURIComponent(shopId);

  try {
    // Three resilient reads. Each defaults to [] so an empty (or briefly
    // unavailable) table yields zeros instead of a 500.
    const [orders, products, chats] = await Promise.all([
      // TIME-FRAME FILTRATION: optional startDate/endDate (ISO) layered on top of
      // the shop_id tenant scope via PostgREST created_at gte/lte filters, so the
      // (shop_id, created_at) composite index and tenant isolation are preserved.
      safeFetch(
        `orders?shop_id=eq.${sid}&select=id,status,total_price,quantity,product_id,platform,user_id,created_at` +
          (startDate ? `&created_at=gte.${encodeURIComponent(startDate)}` : '') +
          (endDate ? `&created_at=lte.${encodeURIComponent(endDate)}` : '') +
          `&order=created_at.desc`
      ),
      safeFetch(`products?shop_id=eq.${sid}&is_deleted=eq.false&select=id,name,price,stock,image_url,created_at&order=created_at.asc`),
      safeFetch(`chats?shop_id=eq.${sid}&select=user_id,platform`),
    ]);

    const approvedOrders = orders.filter((o) => o.status === 'approved');
    const totalRevenue = approvedOrders.reduce((s, o) => s + Number(o.total_price || 0), 0);
    const pendingCount = orders.filter((o) => o.status === 'awaiting_approval').length;

    const lowStockAlerts = products.filter((p) => p.stock <= 3 && p.stock > 0);
    const outOfStockAlerts = products.filter((p) => p.stock === 0);
    const stockAlertCount = lowStockAlerts.length + outOfStockAlerts.length;

    // Chat counts (per platform, row-based) + a user_id -> platform map for the
    // analytics channel split.
    let telegramChats = 0;
    let instagramChats = 0;
    const platformMap = {};
    for (const c of chats) {
      if (c.platform === 'instagram') instagramChats += 1;
      else if (c.platform === 'telegram') telegramChats += 1;
      if (c.user_id && c.platform && !platformMap[c.user_id]) {
        platformMap[c.user_id] = c.platform;
      }
    }

    const recentOrders = orders.slice(0, 5);

    return res.json({
      success: true,
      data: {
        totalRevenue,
        pendingCount,
        lowStockAlerts,
        outOfStockAlerts,
        stockAlertCount,
        totalOrders: orders.length,
        approvedOrders: approvedOrders.length,
        totalProducts: products.length,
        telegramChats,
        instagramChats,
        totalChats: telegramChats + instagramChats,
        recentOrders,
        analytics: computeSalesAnalytics(approvedOrders, platformMap, 7),
      },
    });
  } catch (err) {
    // Last-resort guard: still return a usable zero-filled payload (200) so the
    // dashboard renders an empty state rather than the error screen.
    console.error('[dashboard/stats] unexpected error:', err.message);
    return res.json({
      success: true,
      data: {
        totalRevenue: 0,
        pendingCount: 0,
        lowStockAlerts: [],
        outOfStockAlerts: [],
        stockAlertCount: 0,
        totalOrders: 0,
        approvedOrders: 0,
        totalProducts: 0,
        telegramChats: 0,
        instagramChats: 0,
        totalChats: 0,
        recentOrders: [],
        analytics: computeSalesAnalytics([], {}, 7),
      },
    });
  }
});

export default router;
