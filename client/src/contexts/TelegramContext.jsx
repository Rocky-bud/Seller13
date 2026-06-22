import { createContext, useContext, useEffect, useRef, useState } from 'react';

// ──────────────────────────────────────────────────────────────
// Phase 4 · #1 — Telegram WebApp context provider.
//
// The Mini App checkout previously read `window.Telegram.WebApp.initDataUnsafe`
// directly at submit time. On some Telegram clients that object is not yet
// populated (or is briefly cleared) across React router/state changes, so the
// checkout wrongly concluded the buyer was "outside Telegram" and blocked the
// order with a "return to the bot" error. This provider binds the SDK object
// ONCE on mount and preserves the authenticated context (initData, user,
// start_param) in a ref + sessionStorage so it survives re-renders, navigation
// and transient SDK gaps.
// ──────────────────────────────────────────────────────────────

const TelegramContext = createContext(null);
const SNAPSHOT_KEY = 'tg_webapp_snapshot_v1';

// Telegram appends launch params (incl. tgWebAppData) to the Mini App URL, in
// either the query string or the hash fragment depending on the client.
function readUrlInitData() {
  if (typeof window === 'undefined') return '';
  try {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get('tgWebAppData');
    if (fromQuery) return fromQuery;
    if (url.hash) {
      const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
      const fromHash = hash.get('tgWebAppData');
      if (fromHash) return fromHash;
    }
  } catch (_) { /* ignore malformed URLs */ }
  return '';
}

function parseUserFromInitData(initData) {
  if (!initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const userRaw = params.get('user');
    if (userRaw) return JSON.parse(userRaw);
  } catch (_) { /* ignore */ }
  return null;
}

function readSnapshot() {
  if (typeof window === 'undefined') return null;
  try {
    return JSON.parse(window.sessionStorage.getItem(SNAPSHOT_KEY) || 'null');
  } catch (_) { return null; }
}

// Build a unified context snapshot from every available source, in priority
// order: (1) live SDK object, (2) URL launch params, (3) sessionStorage cache.
function buildSnapshot(tg) {
  let initData = (tg && tg.initData) || '';
  let user = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
  let startParam = (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || null;

  if (!initData) {
    const urlInit = readUrlInitData();
    if (urlInit) {
      initData = urlInit;
      if (!user) user = parseUserFromInitData(urlInit);
    }
  }

  if (!initData || !user || !startParam) {
    const saved = readSnapshot();
    if (saved) {
      if (!initData && saved.initData) initData = saved.initData;
      if (!user && saved.user) user = saved.user;
      if (!startParam && saved.startParam) startParam = saved.startParam;
    }
  }

  const userId = user && user.id != null ? String(user.id) : null;
  const hasContext = Boolean(initData || userId);

  return {
    tg: tg || null,
    initData,
    user,
    userId,
    startParam: startParam || null,
    hasContext,
    isTelegram: Boolean(tg || initData),
    themeParams: (tg && tg.themeParams) || null,
  };
}

export function TelegramProvider({ children }) {
  // Bind the SDK object ONCE — window.Telegram.WebApp is injected by Telegram's
  // telegram-web-app.js script and must not be re-read on every render.
  const tgRef = useRef(
    typeof window !== 'undefined' ? (window.Telegram && window.Telegram.WebApp) || null : null
  );
  const [ctx, setCtx] = useState(() => buildSnapshot(tgRef.current));

  useEffect(() => {
    const tg = tgRef.current;
    if (tg) {
      try { tg.ready(); } catch (_) { /* ignore */ }
      try { tg.expand(); } catch (_) { /* ignore */ }
    }
    const snap = buildSnapshot(tg);
    setCtx(snap);
    // Persist so the chat context survives client-side navigation / reloads that
    // may drop the URL launch params mid-checkout.
    if (snap.hasContext && typeof window !== 'undefined') {
      try {
        window.sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
          initData: snap.initData,
          user: snap.user,
          startParam: snap.startParam,
        }));
      } catch (_) { /* ignore quota errors */ }
    }
  }, []);

  return <TelegramContext.Provider value={ctx}>{children}</TelegramContext.Provider>;
}

// Hook: returns the preserved Telegram context. Falls back to a fresh snapshot
// when called outside the provider so it never throws.
export function useTelegram() {
  const ctx = useContext(TelegramContext);
  if (ctx) return ctx;
  return buildSnapshot(
    typeof window !== 'undefined' ? (window.Telegram && window.Telegram.WebApp) || null : null
  );
}

export default TelegramContext;
