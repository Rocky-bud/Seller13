/**
 * Multi-tenant scope hygiene
 * --------------------------
 * PHASE: Architecture Hardening · Item 4 (Consistent Multi-Tenant Scope Validation)
 *
 * Every merchant-data query in this gateway is scoped by shop_id, and most are
 * interpolated into PostgREST filter strings (e.g. `?shop_id=eq.${shopId}`).
 * A corrupted or malicious shopId (commas, parentheses, dots, quotes, control
 * chars) could therefore break the query or attempt PostgREST operator
 * injection. shopIds in this system are opaque tokens like `SHOP-LKGU6U`, so we
 * can safely constrain them to a strict charset and reject anything else.
 *
 *   - sanitizeShopId(raw): returns a trimmed, validated shopId or null. null
 *     means "absent or corrupt" and the caller decides how strict to be.
 *   - shopScopeGuard: Express middleware applied to merchant-data routers. It
 *     REJECTS a request that carries a present-but-corrupt shopId (query/body)
 *     with a 400, and otherwise attaches the clean value as req.shopId. It does
 *     NOT reject mere absence — route-level RBAC (requireShopRole) owns the
 *     "shopId required" decision so legacy/super-admin flows keep working.
 */

const SHOPID_INVALID = 'شناسهٔ فروشگاه نامعتبر است';

// shopIds are opaque tokens: letters, digits, hyphen, underscore; 1..64 chars.
const SHOP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validate + normalize a shopId from any source. Returns the clean string, or
 * null when the value is missing, empty, over-length, or contains any character
 * outside the safe token charset.
 */
export function sanitizeShopId(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (!SHOP_ID_RE.test(s)) return null;
  return s;
}

/** Read the raw shopId candidate from params, then query, then body. */
export function rawShopId(req) {
  return (
    (req.params && req.params.shopId) ??
    (req.query && req.query.shopId) ??
    (req.body && req.body.shopId) ??
    null
  );
}

/**
 * Defensive Express middleware. Rejects present-but-corrupt shopIds; passes
 * absence through untouched (RBAC decides). Attaches req.shopId when valid.
 */
export function shopScopeGuard(req, res, next) {
  const raw = rawShopId(req);
  if (raw == null || raw === '') {
    req.shopId = null;
    return next();
  }
  const clean = sanitizeShopId(raw);
  if (!clean) {
    return res.status(400).json({ success: false, error: SHOPID_INVALID });
  }
  req.shopId = clean;
  return next();
}

export { SHOPID_INVALID };
export default shopScopeGuard;
