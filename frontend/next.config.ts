import type { NextConfig } from "next";

// Existing custom FastAPI backend (SQLite + WebSocket hub). Its routes live at
// the ROOT (/login, /users, /messages, /terminals/*), so we strip the /api
// prefix here: client code fetches relative /api/* paths and this proxy
// forwards them to the backend root. On Vercel set BACKEND_URL accordingly.
// 127.0.0.1 (not "localhost"): Node may resolve localhost to IPv6 ::1, which
// uvicorn isn't listening on, and the proxy then fails with ECONNREFUSED.
const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:8080";

const nextConfig: NextConfig = {
  // Pin the project root: a stray package-lock.json in the user profile dir
  // otherwise makes Turbopack guess the wrong workspace root and warn.
  turbopack: { root: __dirname },
  // Next 16 rejects dev-server requests for /_next/* from non-localhost
  // origins (403) unless the origin is allow-listed. Set ALLOWED_DEV_ORIGIN
  // to this machine's LAN IP so another PC can open the app in dev mode.
  allowedDevOrigins: process.env.ALLOWED_DEV_ORIGIN
    ? [process.env.ALLOWED_DEV_ORIGIN]
    : [],
  // The rewrite proxy aborts upstream requests after 30s by default and
  // returns a bare 500 "Internal Server Error". /terminals/run can wait up to
  // 35s for an agent (see AgentRegistry.run), so the proxy must outlast it or
  // slow/hung commands surface as opaque 500s instead of graceful messages.
  experimental: { proxyTimeout: 60_000 },
  async rewrites() {
    // Plain (afterFiles) rewrites: Next.js route handlers under app/api/ win;
    // everything else under /api/* is proxied to FastAPI at its root.
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND_URL}/:path*`,
      },
    ];
  },
};

export default nextConfig;
