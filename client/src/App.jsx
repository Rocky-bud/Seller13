import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ShopProvider } from './contexts/ShopContext';
import { TelegramProvider } from './contexts/TelegramContext';
import ProtectedRoute from './components/ProtectedRoute';
import RoleRoute from './components/RoleRoute';

// Phase 4 · #2 — Code splitting & lazy loading.
// The public Telegram Mini App (Storefront) is the ONLY eager import, so mobile
// buyers download just the lightweight catalog bundle. Every private
// merchant-admin surface (dashboard, charts, settings, etc.) is split into its
// own lazy chunk that only loads on demand, behind authentication. See the
// manualChunks config in vite.config.js for the matching vendor split.
import Storefront from './pages/Storefront';

const DashboardLayout = lazy(() => import('./layouts/DashboardLayout'));
const Login = lazy(() => import('./pages/Login'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Products = lazy(() => import('./pages/Products'));
const Receipts = lazy(() => import('./pages/Receipts'));
const Customers = lazy(() => import('./pages/Customers'));
const Settings = lazy(() => import('./pages/Settings'));
const Shops = lazy(() => import('./pages/Shops'));
const Broadcast = lazy(() => import('./pages/Broadcast'));

function RouteFallback() {
  return (
    <div style={ { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: '#64748b', fontFamily: 'Vazirmatn, system-ui, sans-serif' } }>
      <div style={ { textAlign: 'center' } }>
        <div style={ { width: 36, height: 36, margin: '0 auto 12px', border: '3px solid #e2e8f0', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'sf-spin 0.8s linear infinite' } } />
        <div>در حال بارگذاری…</div>
        <style>{`@keyframes sf-spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ShopProvider>
      <BrowserRouter>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            {/* Public Telegram WebApp storefront — eager + minimal bundle, wrapped
                in TelegramProvider so checkout never loses the chat context. */}
            <Route
              path="/store"
              element={(
                <TelegramProvider>
                  <Storefront />
                </TelegramProvider>
              )}
            />

            {/* Public routes (no auth) */}
            <Route path="/login" element={<Login />} />

            {/* Protected area: redirects to /login when unauthenticated */}
            <Route element={<ProtectedRoute />}>
              <Route element={<DashboardLayout />}>
                {/* Every authenticated role sees the dashboard (content adapts). */}
                <Route path="/dashboard" element={<Dashboard />} />

                {/* Shop owner + staff: day-to-day merchant tooling. */}
                <Route element={<RoleRoute allow={['owner', 'staff']} />}>
                  <Route path="/products" element={<Products />} />
                  <Route path="/receipts" element={<Receipts />} />
                  <Route path="/customers" element={<Customers />} />
                </Route>

                {/* Shop owner only: broadcast + bot settings. */}
                <Route element={<RoleRoute allow={['owner']} />}>
                  <Route path="/broadcast" element={<Broadcast />} />
                  <Route path="/settings" element={<Settings />} />
                </Route>

                {/* Super-admin only: cross-shop management. */}
                <Route element={<RoleRoute allow={['super_admin']} />}>
                  <Route path="/shops" element={<Shops />} />
                </Route>
              </Route>
            </Route>

            {/* Defaults */}
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ShopProvider>
  );
}
