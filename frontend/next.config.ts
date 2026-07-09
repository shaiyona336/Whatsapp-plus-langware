import type { NextConfig } from "next";

// Existing custom FastAPI backend (SQLite + WebSocket hub). Its routes live at
// the ROOT (/login, /users, /messages, /terminals/*), so we strip the /api
// prefix here: client code fetches relative /api/* paths and this proxy
// forwards them to the backend root. On Vercel set BACKEND_URL accordingly.
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8080";

const nextConfig: NextConfig = {
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
