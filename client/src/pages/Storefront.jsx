import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useTelegram } from '../contexts/TelegramContext';

// ────────────────────────────────────────────────────────────────────────────
// Centralized, multi-tenant Telegram WebApp storefront.
//
// A SINGLE React route (/store) serves EVERY merchant. The active shop is
// resolved dynamically at runtime, in priority order:
//   1. ?shop_id= (or ?shopId=) query parameter — the bot builds the URL as
//      https://<host>/store?shop_id=XYZ.
//   2. Telegram WebApp start_param (t.me deep-link / startapp).
//
// PART 3 deep-link: an optional ?product_id= opens/scrolls/highlights that
// product (the AI chatbot's photo-card web_app button links straight here).
// PART 4 checkout: the buy flow POSTs to /api/storefront/:shopId/order, which
// writes into the SAME centralized `orders` table the chatbot uses, then shows
// the shop's card number + manual-payment instructions.
//
// Phase 4 · #1: Telegram context is now read from <TelegramProvider> (see
// contexts/TelegramContext.jsx) so the chat identity is preserved across router
// state changes — the checkout never wrongly reports "open from the bot".
// Phase 4 · #5: a native multi-item shopping cart (floating button + bottom
// sheet) lets buyers aggregate items, tune quantities, and review totals before
// the single unified checkout endpoint.
// ────────────────────────────────────────────────────────────────────────────

function resolveShopId(startParam) {
  if (typeof window === 'undefined') return '';
  const qs = new URLSearchParams(window.location.search);
  const fromQuery = qs.get('shop_id') || qs.get('shopId') || qs.get('shop');
  if (fromQuery) return fromQuery.trim();
  if (startParam) return String(startParam).trim();
  return '';
}

function resolveProductId() {
  if (typeof window === 'undefined') return '';
  const qs = new URLSearchParams(window.location.search);
  const fromQuery = qs.get('product_id') || qs.get('productId') || qs.get('product');
  return fromQuery ? String(fromQuery).trim() : '';
}

function toman(n) {
  return Number(n || 0).toLocaleString('fa-IR') + ' تومان';
}

// Per-shop cart cache key (sessionStorage) so the cart survives reloads /
// in-session navigation but never leaks between different merchants.
const CART_KEY_PREFIX = 'sf_cart_v1_';

function loadCart(shopId) {
  if (typeof window === 'undefined' || !shopId) return [];
  try {
    const raw = window.sessionStorage.getItem(CART_KEY_PREFIX + shopId);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

export default function Storefront() {
  const tgCtx = useTelegram();
  const [shopId] = useState(() => resolveShopId(tgCtx.startParam));
  const [deepProductId] = useState(resolveProductId);
  const [state, setState] = useState({ loading: true, error: '', shop: null, products: [] });

  // Checkout + cart panel state.
  const [checkout, setCheckout] = useState(null); // { items, fromCart } | null
  const [cartOpen, setCartOpen] = useState(false);
  const [cart, setCart] = useState(() => loadCart(resolveShopId(tgCtx.startParam)));
  const [highlightId, setHighlightId] = useState('');
  const cardRefs = useRef({});

  // Persist the cart per-shop on every change.
  useEffect(() => {
    if (typeof window === 'undefined' || !shopId) return;
    try { window.sessionStorage.setItem(CART_KEY_PREFIX + shopId, JSON.stringify(cart)); } catch (_) { /* ignore */ }
  }, [cart, shopId]);

  useEffect(() => {
    let cancelled = false;
    if (!shopId) {
      setState({ loading: false, error: 'شناسهٔ فروشگاه پیدا نشد. لطفاً از طریق دکمهٔ ربات وارد شوید.', shop: null, products: [] });
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/storefront/${encodeURIComponent(shopId)}`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || !json.success) {
          setState({ loading: false, error: json.error || 'خطا در دریافت اطلاعات فروشگاه', shop: null, products: [] });
          return;
        }
        setState({ loading: false, error: '', shop: json.data.shop, products: json.data.products || [] });
      } catch (err) {
        if (!cancelled) setState({ loading: false, error: err.message || 'خطای شبکه', shop: null, products: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [shopId]);

  const { loading, error, shop, products } = state;

  // PART 3: once products are loaded, deep-link to ?product_id= — scroll the
  // matched card into view and highlight it briefly so the customer lands
  // exactly on the item the AI chatbot card pointed them to.
  useEffect(() => {
    if (loading || error || !deepProductId || !products.length) return;
    const match = products.find((p) => String(p.id) === String(deepProductId));
    if (!match) return;
    setHighlightId(String(match.id));
    const node = cardRefs.current[String(match.id)];
    if (node && node.scrollIntoView) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    const t = setTimeout(() => setHighlightId(''), 2600);
    return () => clearTimeout(t);
  }, [loading, error, deepProductId, products]);

  // ── Cart operations (Phase 4 · #5) ──────────────────────────────────────────
  const cartCount = useMemo(() => cart.reduce((s, l) => s + Number(l.quantity || 0), 0), [cart]);
  const cartTotal = useMemo(() => cart.reduce((s, l) => s + Number(l.price || 0) * Number(l.quantity || 0), 0), [cart]);

  const addToCart = useCallback((product) => {
    setCart((prev) => {
      const stock = Number(product.stock) || 0;
      const idx = prev.findIndex((l) => String(l.id) === String(product.id));
      if (idx >= 0) {
        const next = prev.slice();
        const capped = stock > 0 ? Math.min(next[idx].quantity + 1, stock) : next[idx].quantity + 1;
        next[idx] = { ...next[idx], quantity: capped };
        return next;
      }
      return [...prev, { id: product.id, name: product.name, price: Number(product.price) || 0, image_url: product.image_url || '', stock, quantity: 1 }];
    });
    setCartOpen(true);
  }, []);

  const changeQty = useCallback((id, delta) => {
    setCart((prev) => prev
      .map((l) => {
        if (String(l.id) !== String(id)) return l;
        const stock = Number(l.stock) || 0;
        let q = l.quantity + delta;
        if (q < 1) q = 0; // 0 → removed below
        if (stock > 0 && q > stock) q = stock;
        return { ...l, quantity: q };
      })
      .filter((l) => l.quantity > 0));
  }, []);

  const removeLine = useCallback((id) => {
    setCart((prev) => prev.filter((l) => String(l.id) !== String(id)));
  }, []);

  const clearCart = useCallback(() => setCart([]), []);

  const openQuickCheckout = useCallback((product) => {
    setCheckout({ items: [{ id: product.id, name: product.name, price: Number(product.price) || 0, stock: Number(product.stock) || 0, quantity: 1 }], fromCart: false });
  }, []);

  const openCartCheckout = useCallback(() => {
    if (!cart.length) return;
    setCheckout({ items: cart.map((l) => ({ id: l.id, name: l.name, price: l.price, stock: l.stock, quantity: l.quantity })), fromCart: true });
  }, [cart]);

  // Telegram theme tokens with sensible light-mode fallbacks (outside Telegram).
  const tp = tgCtx.themeParams || {};
  const theme = {
    bg: tp.bg_color || '#ffffff',
    text: tp.text_color || '#0f172a',
    hint: tp.hint_color || '#64748b',
    card: tp.secondary_bg_color || '#f1f5f9',
    accent: tp.button_color || '#2563eb',
    accentText: tp.button_text_color || '#ffffff',
  };

  const S = {
    page: { minHeight: '100vh', background: theme.bg, color: theme.text, fontFamily: 'Vazirmatn, system-ui, sans-serif', paddingBottom: cartCount > 0 ? 80 : 0 },
    header: { padding: '16px', borderBottom: `1px solid ${theme.card}`, position: 'sticky', top: 0, background: theme.bg, zIndex: 10 },
    title: { margin: 0, fontSize: '1.25rem', fontWeight: 700 },
    subtitle: { margin: '4px 0 0', fontSize: '0.85rem', color: theme.hint },
    main: { padding: '12px 16px 32px' },
    center: { textAlign: 'center', marginTop: 48, color: theme.hint },
    bigEmoji: { fontSize: '2rem', margin: 0 },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 },
    card: { background: theme.card, borderRadius: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column', transition: 'box-shadow .25s, transform .25s' },
    cardHighlight: { boxShadow: `0 0 0 3px ${theme.accent}`, transform: 'translateY(-2px)' },
    img: { width: '100%', aspectRatio: '1 / 1', objectFit: 'cover' },
    imgPlaceholder: { width: '100%', aspectRatio: '1 / 1', display: 'grid', placeItems: 'center', fontSize: '2rem' },
    body: { padding: 10, display: 'flex', flexDirection: 'column', gap: 6, flex: 1 },
    name: { margin: 0, fontSize: '0.95rem', fontWeight: 600 },
    desc: { margin: 0, fontSize: '0.78rem', color: theme.hint, lineHeight: 1.5 },
    priceRow: { marginTop: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
    price: { fontWeight: 700, fontSize: '0.9rem' },
    buyBtn: { marginTop: 8, border: 'none', borderRadius: 10, padding: '8px 10px', fontSize: '0.85rem', fontWeight: 700, cursor: 'pointer', background: theme.accent, color: theme.accentText, fontFamily: 'inherit' },
    cartAddBtn: { marginTop: 6, border: `1px solid ${theme.accent}`, borderRadius: 10, padding: '7px 10px', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', background: 'transparent', color: theme.accent, fontFamily: 'inherit' },
    buyBtnDisabled: { marginTop: 8, border: 'none', borderRadius: 10, padding: '8px 10px', fontSize: '0.85rem', fontWeight: 700, background: theme.card, color: theme.hint, cursor: 'not-allowed', fontFamily: 'inherit', filter: 'grayscale(1)', opacity: 0.7 },
    fabCart: { position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 40, border: 'none', borderRadius: 999, padding: '12px 22px', fontSize: '0.95rem', fontWeight: 700, cursor: 'pointer', background: theme.accent, color: theme.accentText, fontFamily: 'inherit', boxShadow: '0 6px 20px rgba(0,0,0,0.25)', display: 'flex', alignItems: 'center', gap: 8 },
    fabBadge: { background: theme.accentText, color: theme.accent, borderRadius: 999, minWidth: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', fontWeight: 800, padding: '0 6px' },
  };

  return (
    <div dir="rtl" style={S.page}>
      <header style={S.header}>
        <h1 style={S.title}>
          {'🛍️ '}{shop?.name || 'فروشگاه'}
        </h1>
        {shop?.name && <p style={S.subtitle}>به فروشگاه ما خوش آمدید</p>}
      </header>

      <main style={S.main}>
        {loading && <p style={S.center}>در حال بارگذاری محصولات…</p>}

        {!loading && error && (
          <div style={S.center}>
            <p style={S.bigEmoji}>⚠️</p>
            <p>{error}</p>
          </div>
        )}

        {!loading && !error && products.length === 0 && (
          <div style={S.center}>
            <p style={S.bigEmoji}>📦</p>
            <p>هنوز محصولی ثبت نشده است.</p>
          </div>
        )}

        {!loading && !error && products.length > 0 && (
          <div style={S.grid}>
            {products.map((item) => {
              const inStock = Number(item.stock) > 0;
              const stockStyle = { fontSize: '0.72rem', color: inStock ? '#16a34a' : '#dc2626' };
              const isHi = String(item.id) === highlightId;
              const cardStyle = isHi ? { ...S.card, ...S.cardHighlight } : S.card;
              return (
                <article
                  key={item.id}
                  ref={(el) => { cardRefs.current[String(item.id)] = el; }}
                  style={cardStyle}
                >
                  {item.image_url ? (
                    <img src={item.image_url} alt={item.name} loading="lazy" style={S.img} />
                  ) : (
                    <div style={S.imgPlaceholder}>📦</div>
                  )}
                  <div style={S.body}>
                    <h3 style={S.name}>{item.name}</h3>
                    {item.description && <p style={S.desc}>{item.description}</p>}
                    <div style={S.priceRow}>
                      <span style={S.price}>{toman(item.price)}</span>
                      <span style={stockStyle}>
                        {inStock ? `موجود (${item.stock})` : 'ناموجود'}
                      </span>
                    </div>
                    {inStock ? (
                      <>
                        <button type="button" style={S.buyBtn} onClick={() => openQuickCheckout(item)}>
                          🛒 خرید این محصول
                        </button>
                        <button type="button" style={S.cartAddBtn} onClick={() => addToCart(item)}>
                          ➕ افزودن به سبد خرید
                        </button>
                      </>
                    ) : (
                      <button type="button" style={S.buyBtnDisabled} disabled>
                        ناموجود
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>

      {/* Phase 4 · #5: floating "view cart" button with a live item-count badge. */}
      {cartCount > 0 && !cartOpen && !checkout && (
        <button type="button" style={S.fabCart} onClick={() => setCartOpen(true)}>
          <span style={S.fabBadge}>{cartCount.toLocaleString('fa-IR')}</span>
          مشاهده سبد خرید
        </button>
      )}

      {cartOpen && (
        <CartSheet
          cart={cart}
          total={cartTotal}
          theme={theme}
          onChangeQty={changeQty}
          onRemove={removeLine}
          onClear={clearCart}
          onClose={() => setCartOpen(false)}
          onCheckout={() => { setCartOpen(false); openCartCheckout(); }}
        />
      )}

      {checkout && (
        <CheckoutSheet
          shopId={shopId}
          items={checkout.items}
          theme={theme}
          onClose={() => setCheckout(null)}
          onSuccess={() => { if (checkout.fromCart) clearCart(); }}
        />
      )}
    </div>
  );
}

// ── Cart sheet (Phase 4 · #5) ─────────────────────────────────────────────────
// A native bottom-sheet overlay that aggregates every item the buyer added,
// allows live quantity tuning + line removal, shows the running grand total, and
// hands off to the unified CheckoutSheet.
function CartSheet({ cart, total, theme, onChangeQty, onRemove, onClear, onClose, onCheckout }) {
  const K = {
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 60 },
    sheet: { width: '100%', maxWidth: 480, background: theme.bg, color: theme.text, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16, maxHeight: '92vh', overflowY: 'auto', boxSizing: 'border-box', fontFamily: 'Vazirmatn, system-ui, sans-serif' },
    handle: { width: 44, height: 4, borderRadius: 4, background: theme.hint, margin: '0 auto 12px', opacity: 0.4 },
    h: { margin: '0 0 14px', fontSize: '1.05rem', fontWeight: 700 },
    empty: { textAlign: 'center', color: theme.hint, margin: '24px 0' },
    row: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', borderBottom: `1px solid ${theme.card}` },
    info: { flex: 1, minWidth: 0 },
    name: { fontSize: '0.9rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    unit: { fontSize: '0.76rem', color: theme.hint, marginTop: 2 },
    stepper: { display: 'flex', alignItems: 'center', gap: 8 },
    stepBtn: { width: 28, height: 28, borderRadius: 8, border: 'none', background: theme.card, color: theme.text, fontSize: '1.1rem', fontWeight: 700, cursor: 'pointer', lineHeight: 1, fontFamily: 'inherit' },
    qty: { minWidth: 24, textAlign: 'center', fontSize: '0.9rem', fontWeight: 700 },
    lineTotal: { fontSize: '0.82rem', fontWeight: 700, minWidth: 90, textAlign: 'left', direction: 'rtl' },
    remove: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '1rem', color: theme.hint },
    totalRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '14px 0', fontSize: '1rem' },
    btn: { width: '100%', border: 'none', borderRadius: 12, padding: '12px', fontSize: '0.95rem', fontWeight: 700, cursor: 'pointer', background: theme.accent, color: theme.accentText, fontFamily: 'inherit' },
    btnGhost: { width: '100%', border: `1px solid ${theme.card}`, borderRadius: 12, padding: '11px', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer', background: 'transparent', color: theme.text, fontFamily: 'inherit', marginTop: 8 },
  };

  return (
    <div style={K.overlay} onClick={onClose}>
      <div dir="rtl" style={K.sheet} onClick={(e) => e.stopPropagation()}>
        <div style={K.handle} />
        <h2 style={K.h}>🛒 سبد خرید شما</h2>

        {cart.length === 0 ? (
          <p style={K.empty}>سبد خرید شما خالی است.</p>
        ) : (
          <>
            {cart.map((l) => (
              <div key={l.id} style={K.row}>
                <div style={K.info}>
                  <div style={K.name}>{l.name}</div>
                  <div style={K.unit}>{toman(l.price)}</div>
                </div>
                <div style={K.stepper}>
                  <button type="button" style={K.stepBtn} onClick={() => onChangeQty(l.id, -1)}>−</button>
                  <span style={K.qty}>{Number(l.quantity).toLocaleString('fa-IR')}</span>
                  <button type="button" style={K.stepBtn} onClick={() => onChangeQty(l.id, 1)}>+</button>
                </div>
                <div style={K.lineTotal}>{toman(Number(l.price) * Number(l.quantity))}</div>
                <button type="button" style={K.remove} onClick={() => onRemove(l.id)} aria-label="حذف">🗑</button>
              </div>
            ))}

            <div style={K.totalRow}>
              <span>جمع کل</span>
              <b>{toman(total)}</b>
            </div>

            <button type="button" style={K.btn} onClick={onCheckout}>تکمیل خرید</button>
            <button type="button" style={K.btnGhost} onClick={onClear}>خالی کردن سبد</button>
          </>
        )}

        <button type="button" style={K.btnGhost} onClick={onClose}>بستن</button>
      </div>
    </div>
  );
}

// ── Checkout sheet (PART 4 + Phase 4 · #1/#5) ─────────────────────────────────
// Collects delivery details, registers the order through the centralized public
// endpoint (same `orders` table as the chatbot) using the UNIFIED items[] array,
// then shows the merchant's card number + manual-payment instructions and asks
// the customer to send the receipt inside the Telegram bot. Telegram identity is
// read from the preserved context, never the volatile live SDK object.
function CheckoutSheet({ shopId, items, theme, onClose, onSuccess }) {
  const tgCtx = useTelegram();
  const [lineItems, setLineItems] = useState(items);
  const [form, setForm] = useState({ customer_name: '', phone: '', address: '', postal_code: '' });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null); // { order_id, total_price, payment } | null

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const isSingle = lineItems.length === 1;
  const total = lineItems.reduce((s, l) => s + Number(l.price) * Number(l.quantity), 0);

  const setSingleQty = (e) => {
    const q = Math.max(1, parseInt(e.target.value, 10) || 1);
    setLineItems((prev) => prev.map((l, i) => (i === 0 ? { ...l, quantity: q } : l)));
  };

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (!form.customer_name.trim()) { setErr('نام و نام خانوادگی را وارد کنید.'); return; }
    if (!form.phone.trim()) { setErr('شماره تماس را وارد کنید.'); return; }
    if (!form.address.trim()) { setErr('آدرس تحویل را وارد کنید.'); return; }
    // Phase 4 · #1: identity comes from the preserved Telegram context.
    const tgUserId = tgCtx.userId;
    if (!tgUserId) { setErr('برای ثبت سفارش، لطفاً فروشگاه را از داخل ربات تلگرام باز کنید.'); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/storefront/${encodeURIComponent(shopId)}/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: tgUserId,
          items: lineItems.map((l) => ({ product_id: l.id, quantity: Math.max(1, parseInt(l.quantity, 10) || 1) })),
          customer_name: form.customer_name.trim(),
          phone: form.phone.trim(),
          address: form.address.trim(),
          postal_code: form.postal_code.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setErr(json.error || 'ثبت سفارش ناموفق بود.');
        setSubmitting(false);
        return;
      }
      setResult(json);
      if (typeof onSuccess === 'function') onSuccess();
    } catch (e2) {
      setErr(e2.message || 'خطای شبکه');
    } finally {
      setSubmitting(false);
    }
  };

  const C = {
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 70 },
    sheet: { width: '100%', maxWidth: 480, background: theme.bg, color: theme.text, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16, maxHeight: '92vh', overflowY: 'auto', boxSizing: 'border-box', fontFamily: 'Vazirmatn, system-ui, sans-serif' },
    handle: { width: 44, height: 4, borderRadius: 4, background: theme.hint, margin: '0 auto 12px', opacity: 0.4 },
    h: { margin: '0 0 4px', fontSize: '1.05rem', fontWeight: 700 },
    sub: { margin: '0 0 14px', fontSize: '0.85rem', color: theme.hint },
    itemRow: { display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', padding: '4px 0', color: theme.text },
    label: { display: 'block', fontSize: '0.8rem', marginBottom: 4, color: theme.hint },
    field: { width: '100%', boxSizing: 'border-box', padding: '10px 12px', marginBottom: 12, border: `1px solid ${theme.card}`, borderRadius: 10, background: theme.card, color: theme.text, fontFamily: 'inherit', fontSize: '0.9rem' },
    btn: { width: '100%', border: 'none', borderRadius: 12, padding: '12px', fontSize: '0.95rem', fontWeight: 700, cursor: 'pointer', background: theme.accent, color: theme.accentText, fontFamily: 'inherit' },
    btnGhost: { width: '100%', border: `1px solid ${theme.card}`, borderRadius: 12, padding: '11px', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer', background: 'transparent', color: theme.text, fontFamily: 'inherit', marginTop: 8 },
    err: { background: '#fee2e2', color: '#b91c1c', padding: '8px 12px', borderRadius: 10, fontSize: '0.82rem', marginBottom: 12 },
    totalBox: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '6px 0 14px', paddingTop: 10, borderTop: `1px solid ${theme.card}`, fontWeight: 700 },
    cardBox: { background: theme.card, borderRadius: 12, padding: 14, textAlign: 'center', margin: '10px 0' },
    cardNum: { fontSize: '1.3rem', fontWeight: 700, letterSpacing: '2px', direction: 'ltr', fontFamily: 'monospace', margin: '6px 0' },
    okEmoji: { fontSize: '2.4rem', textAlign: 'center', margin: '4px 0' },
  };

  return (
    <div style={C.overlay} onClick={onClose}>
      <div dir="rtl" style={C.sheet} onClick={(e) => e.stopPropagation()}>
        <div style={C.handle} />

        {!result ? (
          <form onSubmit={submit}>
            <h2 style={C.h}>تکمیل خرید</h2>
            <p style={C.sub}>{isSingle ? `${lineItems[0].name} — ${toman(lineItems[0].price)}` : `سبد خرید شما (${lineItems.length.toLocaleString('fa-IR')} قلم)`}</p>

            {!isSingle && lineItems.map((l) => (
              <div key={l.id} style={C.itemRow}>
                <span>{l.name} × {Number(l.quantity).toLocaleString('fa-IR')}</span>
                <span>{toman(Number(l.price) * Number(l.quantity))}</span>
              </div>
            ))}

            {err && <div style={C.err}>{err}</div>}

            <label style={C.label}>نام و نام خانوادگی</label>
            <input style={C.field} value={form.customer_name} onChange={set('customer_name')} placeholder="مثلاً: علی رضایی" />

            <label style={C.label}>شماره تماس</label>
            <input style={C.field} value={form.phone} onChange={set('phone')} inputMode="tel" placeholder="09xxxxxxxxx" />

            <label style={C.label}>آدرس تحویل</label>
            <input style={C.field} value={form.address} onChange={set('address')} placeholder="آدرس کامل پستی" />

            <label style={C.label}>کد پستی (اختیاری)</label>
            <input style={C.field} value={form.postal_code} onChange={set('postal_code')} inputMode="numeric" placeholder="کد پستی ۱۰ رقمی" />

            {isSingle && (
              <>
                <label style={C.label}>تعداد</label>
                <input style={C.field} type="number" min="1" value={lineItems[0].quantity} onChange={setSingleQty} />
              </>
            )}

            <div style={C.totalBox}>
              <span>جمع کل قابل پرداخت</span>
              <span>{toman(total)}</span>
            </div>

            <button type="submit" style={C.btn} disabled={submitting}>
              {submitting ? 'در حال ثبت…' : '✅ ثبت سفارش'}
            </button>
            <button type="button" style={C.btnGhost} onClick={onClose}>انصراف</button>
          </form>
        ) : (
          <div>
            <div style={C.okEmoji}>✅</div>
            <h2 style={C.h}>سفارش شما ثبت شد</h2>
            <p style={C.sub}>
              مبلغ قابل پرداخت: <b>{toman(result.total_price)}</b>
            </p>
            <div style={C.cardBox}>
              <div style={C.sub}>💳 شماره کارت فروشگاه</div>
              <div style={C.cardNum}>{result.payment?.card_number || '—'}</div>
              {!result.payment?.card_valid && (
                <div style={C.sub}>شماره کارت فروشگاه هنوز ثبت نشده است؛ لطفاً با پشتیبانی هماهنگ کنید.</div>
              )}
            </div>
            <p style={C.sub}>
              پس از واریز، لطفاً <b>رسید پرداخت</b> را داخل ربات تلگرام ارسال کنید تا سفارش شما تأیید و پردازش شود.
            </p>
            <button type="button" style={C.btn} onClick={onClose}>متوجه شدم</button>
          </div>
        )}
      </div>
    </div>
  );
}
