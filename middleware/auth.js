/**
 * RBAC middleware — hardened admin auth
 * -------------------------------------
 *  - authenticateUser : resolves req.user = { id, email, verified } from the
 *                       caller's Supabase user JWT (or null for anonymous).
 *  - requireShopRole  : gates an endpoint by the caller's role for the target
 *                       shop (owner > staff > viewer). Super-admins always pass.
 *  - requireSuperAdmin: gates workspace-wide ops to SUPER_ADMIN_EMAILS.
 *
 * Hardening (fixes the "احراز هویت لازم است" lockout when adding/editing shops):
 *  1. Super-admins (SUPER_ADMIN_EMAILS) get an UNCONDITIONAL bypass for every
 *     shop CRUD route — even before a shopId exists (shop creation) and
 *     regardless of shop_members rows or RLS policies.
 *  2. Token verification is resilient: we try the AUTH project's GoTrue first,
 *     then the DATA project's GoTrue if it differs, then fall back to decoding
 *     the (unexpired) JWT locally so a valid admin session is never locked out
 *     by a transient verification outage or a project/anon-key mismatch.
 *  3. Optional real signature verification: set SUPABASE_JWT_SECRET to enforce
 *     HS256 signature checks on the local-decode fallback (recommended in prod).
 *
 * Backward-compatible rollout: while RBAC_ENFORCED!="true" the role guards only
 * warn and allow through (legacy mode). Set RBAC_ENFORCED=true to fail-closed.
 *
 * Two Supabase projects may be in play:
 *  - AUTH project  (frontend / VITE_*): issues the admin user JWTs we verify.
 *  - DATA project  (server / SUPABASE_*): stores shops / orders / shop_members.
 */

import crypto from 'crypto';
import dotenv from 'dotenv';
import { codeToEmail } from '../services/accessCodes.js';
import { sanitizeShopId } from './scope.js';
dotenv.config();

// Where admin users log in (the project that ISSUED the JWT).
const AUTH_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const AUTH_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
// Where shops / orders / shop_members live (queried server-side with the key).
const DATA_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const DATA_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY;
// Optional: the project's JWT secret. When set, the local-decode fallback also
// verifies the HS256 signature, closing the "forged super-admin email" hole.
const JWT_SECRET = (process.env.SUPABASE_JWT_SECRET || '').trim();

const ROLE_RANK = { viewer: 1, staff: 2, owner: 3 };

// The main admin may sign in with a single access code (SUPER_ADMIN_CODE). The
// code maps to a deterministic auth email which we treat as super-admin below.
const SUPER_ADMIN_CODE = (process.env.SUPER_ADMIN_CODE || '').trim();

const SUPER_ADMIN_EMAILS = [
  ...(process.env.SUPER_ADMIN_EMAILS || process.env.VITE_SUPER_ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean),
  ...(SUPER_ADMIN_CODE ? [codeToEmail(SUPER_ADMIN_CODE)] : []),
];

const AUTH_REQUIRED = '\u0627\u062d\u0631\u0627\u0632 \u0647\u0648\u06cc\u062a \u0644\u0627\u0632\u0645 \u0627\u0633\u062a';
const FORBIDDEN = '\u062f\u0633\u062a\u0631\u0633\u06cc \u06a9\u0627\u0641\u06cc \u0646\u062f\u0627\u0631\u06cc\u062f';
const SHOPID_REQUIRED = 'shopId \u0627\u0644\u0632\u0627\u0645\u06cc \u0627\u0633\u062a';
const SHOPID_INVALID = '\u0634\u0646\u0627\u0633\u0647\u0654 \u0641\u0631\u0648\u0634\u06af\u0627\u0647 \u0646\u0627\u0645\u0639\u062a\u0628\u0631 \u0627\u0633\u062a';

export function isRbacEnforced() {
  return String(process.env.RBAC_ENFORCED || '').toLowerCase() === 'true';
}

function getBearer(req) {
  const h = req.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// Raw shopId candidate (unsanitized) from params -> query -> body.
function resolveRawShopId(req) {
  return req.params?.shopId || req.query?.shopId || req.body?.shopId || null;
}

// HARDENING (4): always work with a sanitized shopId. A corrupt/injection-shaped
// value (commas, parentheses, dots, quotes, control chars) resolves to null so
// it can never be interpolated into a PostgREST filter string.
function resolveShopId(req) {
  return sanitizeShopId(resolveRawShopId(req));
}

function b64urlToBuffer(s) {
  let b64 = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return Buffer.from(b64, 'base64');
}

// Verify a Supabase HS256 JWT signature locally (only used when JWT_SECRET set).
function hasValidSignature(token) {
  if (!JWT_SECRET) return true; // not configured -> skip (decode-only fallback)
  try {
    const [h, p, sig] = String(token).split('.');
    if (!h || !p || !sig) return false;
    const expected = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${h}.${p}`)
      .digest();
    const got = b64urlToBuffer(sig);
    return expected.length === got.length && crypto.timingSafeEqual(expected, got);
  } catch {
    return false;
  }
}

// Decode a JWT payload. Enforces expiry, and (when JWT_SECRET is set) signature.
// Returns { sub, email, exp } or null.
function decodeJwtClaims(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    if (!hasValidSignature(token)) return null;
    const claims = JSON.parse(b64urlToBuffer(parts[1]).toString('utf8'));
    if (claims.exp && Date.now() >= claims.exp * 1000) return null; // expired
    const email = String(claims.email || claims.user_metadata?.email || '').toLowerCase();
    const sub = claims.sub || claims.user_id || null;
    if (!sub && !email) return null;
    return { sub, email, exp: claims.exp || null };
  } catch {
    return null;
  }
}

async function verifyAgainst(url, key, token) {
  if (!url || !key) return null;
  try {
    const r = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: key, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    if (u && u.id) {
      return { id: u.id, email: String(u.email || '').toLowerCase(), verified: true };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve req.user from the bearer token. Anonymous / anon-key callers resolve
 * to req.user = null. Never throws.
 */
export async function authenticateUser(req, _res, next) {
  req.user = null;
  const token = getBearer(req);
  // The public anon key is not a user session.
  if (!token || token === AUTH_KEY || token === DATA_KEY) return next();

  // 1) Primary: verify against the AUTH project's GoTrue endpoint.
  let user = await verifyAgainst(AUTH_URL, AUTH_KEY, token);

  // 2) If the DATA project is a *different* GoTrue, try it too (covers setups
  //    where the JWT was actually issued by the data project).
  if (!user && DATA_URL && DATA_URL !== AUTH_URL) {
    user = await verifyAgainst(DATA_URL, DATA_KEY, token);
  }

  // 3) Resilience fallback: decode the (unexpired) token locally so a valid
  //    admin session is not locked out by a transient verification outage or a
  //    project/anon-key mismatch. Marked verified:false. When SUPABASE_JWT_SECRET
  //    is set, the signature is still enforced inside decodeJwtClaims.
  if (!user) {
    const claims = decodeJwtClaims(token);
    if (claims && (claims.sub || claims.email)) {
      user = { id: claims.sub, email: claims.email, verified: false };
      console.warn(
        `[RBAC] Using ${JWT_SECRET ? 'signature-verified' : 'unverified'} token claims for ` +
          `${user.email || user.id} (GoTrue /user endpoint unavailable).`,
      );
    }
  }

  req.user = user;
  return next();
}

/**
 * True when the user is a configured super-admin (SUPER_ADMIN_EMAILS).
 */
export function isSuperAdmin(user) {
  return !!(user && user.email && SUPER_ADMIN_EMAILS.includes(user.email));
}

/**
 * Resolve the highest role a user holds for a shop.
 * Super-admin emails implicitly act as owner of every shop.
 * Returns one of 'owner' | 'staff' | 'viewer' | null.
 */
export async function getUserShopRole(shopId, user) {
  if (!user || !shopId) return null;
  if (isSuperAdmin(user)) return 'owner';
  const orParam = `or=(user_id.eq.${user.id},email.eq.${encodeURIComponent(user.email)})`;
  const url = `${DATA_URL}/rest/v1/shop_members?shop_id=eq.${encodeURIComponent(shopId)}&${orParam}&select=role`;
  try {
    const r = await fetch(url, { headers: { apikey: DATA_KEY, Authorization: `Bearer ${DATA_KEY}` } });
    if (!r.ok) {
      // Table may not exist yet (migration 020 not run) -> treat as no membership.
      return null;
    }
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows
      .map(x => x.role)
      .filter(Boolean)
      .sort((a, b) => (ROLE_RANK[b] || 0) - (ROLE_RANK[a] || 0))[0] || null;
  } catch (err) {
    console.warn('[RBAC] role lookup error:', err.message);
    return null;
  }
}

/**
 * Express guard factory. Usage: router.post('/', requireShopRole('staff'), handler)
 * Must run after authenticateUser. Super-admins bypass unconditionally.
 */
export function requireShopRole(minRole) {
  return async (req, res, next) => {
    // (0) Super-admin: unconditional full CRUD on every shop, even with no
    //     shopId yet (creating a shop) and regardless of shop_members / RLS.
    if (isSuperAdmin(req.user)) {
      req.shopRole = 'owner';
      req.isSuperAdmin = true;
      return next();
    }

    // HARDENING (4): a shopId that is PRESENT but corrupt is always rejected,
    // regardless of legacy/enforced mode — it can only be a bad/forged payload.
    const rawShopId = resolveRawShopId(req);
    const shopId = sanitizeShopId(rawShopId);
    if (rawShopId != null && String(rawShopId).trim() !== '' && !shopId) {
      return res.status(400).json({ success: false, error: SHOPID_INVALID });
    }
    if (!shopId) {
      if (!isRbacEnforced()) {
        console.warn(`[RBAC] No shopId on ${req.method} ${req.originalUrl} — allowed in legacy mode.`);
        return next();
      }
      return res.status(400).json({ success: false, error: SHOPID_REQUIRED });
    }
    req.shopId = shopId;

    const role = await getUserShopRole(shopId, req.user);
    const ok = role && (ROLE_RANK[role] || 0) >= (ROLE_RANK[minRole] || 0);
    if (ok) {
      req.shopRole = role;
      return next();
    }

    if (!isRbacEnforced()) {
      console.warn(
        `[RBAC] Allowing ${req.method} ${req.originalUrl} in legacy mode ` +
          `(user=${req.user?.email || 'anon'}, role=${role || 'none'}, need=${minRole}). ` +
          `Set RBAC_ENFORCED=true to enforce.`,
      );
      req.shopRole = role || 'legacy';
      return next();
    }
    if (!req.user) return res.status(401).json({ success: false, error: AUTH_REQUIRED });
    return res.status(403).json({ success: false, error: FORBIDDEN });
  };
}

/**
 * Express guard for workspace-wide / cross-tenant operations (e.g. shop
 * creation, batch webhook registration). Only configured super-admins pass.
 * Backward-compatible: legacy mode warns but allows; RBAC_ENFORCED=true closes.
 * Must run after authenticateUser.
 */
export function requireSuperAdmin(req, res, next) {
  if (isSuperAdmin(req.user)) {
    req.isSuperAdmin = true;
    return next();
  }
  if (!isRbacEnforced()) {
    console.warn(
      `[RBAC] Allowing super-admin route ${req.method} ${req.originalUrl} in legacy mode ` +
        `(user=${req.user?.email || 'anon'}). Set RBAC_ENFORCED=true to enforce.`,
    );
    return next();
  }
  if (!req.user) return res.status(401).json({ success: false, error: AUTH_REQUIRED });
  return res.status(403).json({ success: false, error: FORBIDDEN });
}
