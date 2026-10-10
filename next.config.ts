import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: "1mb",
    },
  },
  // The worker runs separately (npm run worker); keep pg out of the client bundle.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
