/**
 * asyncHandler + global crash-prevention middleware
 * --------------------------------------------------
 * PHASE: Architecture Hardening · Item 1 (Global Error Handling & Crash Prevention)
 *
 * The Express app previously had no terminal error-handling middleware and no
 * process-level safety nets. That meant:
 *   - A throw inside an `async` route that wasn't caught locally became an
 *     unhandled promise rejection.
 *   - An unhandled rejection / uncaught exception could tear down the whole
 *     Node process, taking every merchant's bot offline at once.
 *
 * This module provides the three pieces that make the gateway resilient:
 *   - asyncHandler(fn): wraps an async route so any rejection is forwarded to
 *     Express's error pipeline (next(err)) instead of escaping as an unhandled
 *     rejection.
 *   - errorHandler:    the single terminal (4-arg) middleware. Logs the full
 *     error server-side, never leaks a stack trace to the client, and always
 *     answers /api/* requests with the project's { success:false, error } JSON
 *     envelope so the frontend hooks degrade gracefully.
 *   - notFoundHandler: JSON 404 for unmatched /api/* routes.
 *   - installProcessSafetyNets(): last-resort process guards so a stray
 *     rejection/exception is logged but the server keeps serving traffic.
 */

/**
 * Wrap an async Express handler so a rejected promise is routed to the global
 * error handler instead of crashing the process. Sync throws are caught too.
 *
 * Usage: router.get('/x', asyncHandler(async (req, res) => { ... }))
 */
export function asyncHandler(fn) {
  return function wrappedAsyncHandler(req, res, next) {
    try {
      const out = fn(req, res, next);
      if (out && typeof out.then === 'function') {
        out.catch(next);
      }
    } catch (err) {
      next(err);
    }
  };
}

/** JSON 404 for unmatched API routes; plain text otherwise. */
export function notFoundHandler(req, res) {
  if ((req.path || '').startsWith('/api/')) {
    return res.status(404).json({ success: false, error: 'مسیر مورد نظر یافت نشد' });
  }
  return res.status(404).send('Not found');
}

/**
 * Terminal Express error handler. MUST be registered last (after all routes)
 * and MUST keep all four parameters so Express recognizes it as an error
 * handler. Never throws, never leaks internals.
 */
export function errorHandler(err, req, res, next) {
  const status = Number(err && (err.status || err.statusCode)) || 500;

  // Always log the real error server-side for diagnosis.
  console.error(
    `[errorHandler] ${req.method} ${req.originalUrl} -> ${status}:`,
    (err && (err.stack || err.message)) || err,
  );

  // If the response already started streaming, defer to Express's default
  // handler which will close the socket safely.
  if (res.headersSent) return next(err);

  if ((req.path || '').startsWith('/api/')) {
    // 5xx -> generic Persian message (don't expose internals). 4xx -> the
    // specific message is safe to surface to the client.
    const message =
      status >= 500
        ? 'خطای داخلی سرور. لطفاً کمی بعد دوباره تلاش کنید.'
        : (err && err.message) || 'درخواست نامعتبر است';
    return res.status(status).json({ success: false, error: message });
  }

  return res.status(status).send('Internal Server Error');
}

/**
 * Install last-resort process guards. The user requirement is explicit: an
 * unexpected error in the AI runtime, a third-party webhook, or a Supabase
 * fetch must NEVER crash the Node process. We log loudly and keep serving;
 * individual requests still fail safely via their own try/catch + errorHandler.
 */
export function installProcessSafetyNets() {
  if (globalThis.__safetyNetsInstalled) return; // idempotent
  globalThis.__safetyNetsInstalled = true;

  process.on('unhandledRejection', (reason) => {
    console.error(
      '[process] Unhandled promise rejection (server kept alive):',
      (reason && (reason.stack || reason.message)) || reason,
    );
  });

  process.on('uncaughtException', (err) => {
    console.error(
      '[process] Uncaught exception (server kept alive):',
      (err && (err.stack || err.message)) || err,
    );
  });
}

export default asyncHandler;
