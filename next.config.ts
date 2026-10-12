import type { NextConfig } from "next";

const config: NextConfig = {
  // Worker-only packages must never be bundled into the web app.
  serverExternalPackages: ["playwright", "bullmq", "ioredis", "pg", "pino"],
  poweredByHeader: false,
  experimental: { serverActions: { bodySizeLimit: "5mb" } },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default config;
