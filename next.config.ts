import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['@anthropic-ai/sdk'],
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
