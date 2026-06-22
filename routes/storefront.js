import { Router } from 'express';
import dotenv from 'dotenv';
import { createWebAppOrder } from '../services/aiService.js';
dotenv.config();

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY;

const BASE_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

async function supaFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: BASE_HEADERS });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase error (${res.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

// Insert helper (returns the created row) — used by the public checkout below.
async function supaWrite(table, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...BASE_HEADERS, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase error (${res.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

// Format a 16-digit card number into groups of four for display.
function formatCard(card) {
  const digits = (card || '').replace(/\D/g, '');
  if (digits.length !== 16) return { valid: false, display: card || '' };
  return { valid: true, display: digits.replace(/(\d{4})(?=\d)/g, '$1-') };
}

function formatTomanInt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

// ── GET /api/storefront/:shopId ──────────────────────────────────────────
// PUBLIC endpoint consumed by the centralized Telegram WebApp (Mini App).
// Multi-tenant: the :shopId path segment (built by the bot as
// /store?shop_id=XYZ) scopes the response to exactly ONE merchant. Only safe,
// customer-facing fields are returned — never tokens, card numbers or prompts.
router.get('/:shopId', async (req, res) => {
  const shopId = (req.params.shopId || '').trim();
  if (!shopId) {
    return res.status(400).json({ success: false, error: 'شناسهٔ فروشگاه الزامی است' });
  }
  try {
    const shopRows = await supaFetch(
      `shops?id=eq.${encodeURIComponent(shopId)}&select=id,name,is_active&limit=1`
    );
    const shop = Array.isArray(shopRows) ? shopRows[0] : null;
    if (!shop) {
      return res.status(404).json({ success: false, error: 'فروشگاه پیدا نشد' });
    }
    if (shop.is_active === false) {
      return res.status(403).json({ success: false, error: 'این فروشگاه غیرفعال است' });
    }

    // SOFT-DELETE (migration 038): never surface archived products to buyers.
    const products = await supaFetch(
      `products?shop_id=eq.${encodeURIComponent(shopId)}&is_deleted=eq.false` +
        `&select=id,name,price,stock,description,image_url&order=created_at.asc`
    );

    res.set('Cache-Control', 'public, max-age=30');
    return res.json({
      success: true,
      data: {
        shop: { id: shop.id, name: shop.name },
        products: Array.isArray(products) ? products : [],
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/storefront/:shopId/order ───────────────────────────────
// PART 4: the Mini-App checkout registers its order in the SAME centralized
// `orders` table as the conversational bot, then returns the manual card
// payment instructions. Public (no auth): the order is bound to the Telegram
// user id passed from the Mini App initData. Accepts either a full items[]
// array or a single { product_id, quantity } shorthand.
router.post('/:shopId/order', async (req, res) => {
  const shopId = (req.params.shopId || '').trim();
  if (!shopId) return res.status(400).json({ success: false, error: 'شناسهٔ فروشگاه الزامی است' });

  const { user_id, items, product_id, quantity, customer_name, phone, address, postal_code } = req.body || {};
  const list = Array.isArray(items) && items.length
    ? items
    : (product_id ? [{ product_id, quantity: quantity || 1 }] : []);
  if (!user_id) return res.status(400).json({ success: false, error: 'شناسهٔ کاربر تلگرام الزامی است' });
  if (!list.length) return res.status(400).json({ success: false, error: 'سبد خرید خالی است' });

  try {
    const shopRows = await supaFetch(`shops?id=eq.${encodeURIComponent(shopId)}&select=id,is_active&limit=1`);
    const shop = Array.isArray(shopRows) ? shopRows[0] : null;
    if (!shop) return res.status(404).json({ success: false, error: 'فروشگاه پیدا نشد' });
    if (shop.is_active === false) return res.status(403).json({ success: false, error: 'این فروشگاه غیرفعال است' });

    const result = await createWebAppOrder({
      shopId,
      userId: user_id,
      items: list,
      customerName: customer_name,
      phone,
      address,
      postalCode: postal_code,
    });
    if (!result.success) return res.status(400).json(result);
    // Response shape consumed by the Mini App CheckoutSheet success screen.
    return res.json({
      success: true,
      order_id: result.orderId,
      order_ids: result.orderIds,
      total_price: result.subtotal,
      payment: { card_number: result.cardNumber, card_valid: result.cardValid, shop_name: result.shopName },
      instructions: result.instructions,
      data: result,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/storefront/:shopId/order ───────────────────────────────
// PART 4 (system synchronization): PUBLIC checkout for the Mini App storefront.
// It registers the order in the EXACT SAME centralized `orders` table the
// Telegram/Instagram chatbot checkout uses (identical columns + status), then
// returns the shop's card number + manual-payment instructions so the WebApp can
// tell the customer where to pay and to send the receipt inside the bot. Both
// channels therefore converge on one order pipeline + one payment flow.
router.post('/:shopId/order', async (req, res) => {
  const shopId = (req.params.shopId || '').trim();
  if (!shopId) return res.status(400).json({ success: false, error: 'شناسهٔ فروشگاه الزامی است' });

  const { product_id, quantity, customer_name, phone, address, postal_code } = req.body || {};
  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  if (!product_id) return res.status(400).json({ success: false, error: 'محصول انتخاب نشده است' });
  if (!customer_name || !String(customer_name).trim()) return res.status(400).json({ success: false, error: 'نام و نام خانوادگی الزامی است' });
  if (!phone || !String(phone).trim()) return res.status(400).json({ success: false, error: 'شماره تماس الزامی است' });
  if (!address || !String(address).trim()) return res.status(400).json({ success: false, error: 'آدرس تحویل الزامی است' });

  try {
    // 1) shop must exist + be active; grab its card number for the instructions.
    const shopRows = await supaFetch(
      `shops?id=eq.${encodeURIComponent(shopId)}&select=id,name,is_active,card_number&limit=1`
    );
    const shop = Array.isArray(shopRows) ? shopRows[0] : null;
    if (!shop) return res.status(404).json({ success: false, error: 'فروشگاه پیدا نشد' });
    if (shop.is_active === false) return res.status(403).json({ success: false, error: 'این فروشگاه غیرفعال است' });

    // 2) product must belong to this shop; trust the DB price, never the client.
    const prodRows = await supaFetch(
      `products?id=eq.${encodeURIComponent(product_id)}&shop_id=eq.${encodeURIComponent(shopId)}&is_deleted=eq.false&select=id,name,price,stock&limit=1`
    );
    const product = Array.isArray(prodRows) ? prodRows[0] : null;
    if (!product) return res.status(404).json({ success: false, error: 'محصول پیدا نشد' });
    if (Number(product.stock) < qty) return res.status(409).json({ success: false, error: 'موجودی کافی نیست' });
    if (!Number.isFinite(Number(product.price)) || Number(product.price) <= 0) {
      return res.status(409).json({ success: false, error: 'قیمت محصول نامعتبر است' });
    }

    const totalPrice = Number(product.price) * qty;

    // 3) insert into the SAME orders table as the chatbot checkout. The base row
    //    matches the chatbot's insert shape exactly; lifecycle_status +
    //    postal_code are added when those columns exist (migration 036). If the
    //    DB hasn't been migrated yet we transparently retry without them so
    //    checkout never hard-fails.
    const baseRow = {
      user_id: `webapp:${String(phone).trim()}`,
      product_id: product.id,
      quantity: qty,
      total_price: totalPrice,
      status: 'pending_receipt',
      shop_id: shopId,
      customer_name: String(customer_name).trim(),
      shipping_address: String(address).trim(),
      phone: String(phone).trim(),
      platform: 'webapp',
    };
    const fullRow = {
      ...baseRow,
      lifecycle_status: 'pending',
      postal_code: postal_code ? String(postal_code).trim() : null,
    };

    let order;
    try {
      const inserted = await supaWrite('orders', fullRow);
      order = Array.isArray(inserted) ? inserted[0] : inserted;
    } catch (e) {
      if (/column|lifecycle_status|postal_code|schema cache/i.test(e.message)) {
        const inserted = await supaWrite('orders', baseRow);
        order = Array.isArray(inserted) ? inserted[0] : inserted;
      } else {
        throw e;
      }
    }

    // 4) manual card-payment instructions (identical to the bot's flow).
    const card = formatCard(shop.card_number);
    return res.json({
      success: true,
      order_id: order?.id || null,
      total_price: totalPrice,
      product: { id: product.id, name: product.name, price: Number(product.price) },
      payment: {
        card_number: card.display,
        card_valid: card.valid,
        instructions:
          'سفارش شما ثبت شد ✅\n' +
          `لطفاً مبلغ ${formatTomanInt(totalPrice)} تومان را به شماره کارت زیر واریز کنید و سپس رسید پرداخت را داخل ربات تلگرام ارسال نمایید.`,
      },
    });
  } catch (err) {
    console.error('[storefront/order] error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
