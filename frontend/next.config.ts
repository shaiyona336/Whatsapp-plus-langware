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
  // Next 16 returns 403 for /_next/* (its JS chunks) when the page was opened
  // from a non-localhost origin, which renders as a BLANK WHITE PAGE (the HTML
  // shell loads, so the <title> shows, but no JS runs). Allow-list the origins
  // that need dev assets:
  //   - the tunnel wildcards: any per-run cloudflared/ngrok URL works for the
  //     remote-over-internet demo (remote.txt) with NO env var to set;
  //   - ALLOWED_DEV_ORIGIN: this machine's LAN IP for the two-PC demo
  //     (two_pcs.txt) — an IP isn't a tunnel host, so it still needs the env.
  // Wildcards match one subdomain label only; bare trycloudflare.com and
  // unrelated hosts are still rejected (verified against Next's matcher).
  allowedDevOrigins: [
    "*.trycloudflare.com",
    "*.ngrok-free.app",
    "*.ngrok.app",
    "*.ngrok.io",
    ...(process.env.ALLOWED_DEV_ORIGIN ? [process.env.ALLOWED_DEV_ORIGIN] : []),
  ],
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
