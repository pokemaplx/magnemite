import type { NextConfig } from "next";

const config: NextConfig = {
  // Workspace packages ship TypeScript source rather than a build output.
  transpilePackages: ["@magnemite/db"],
  // Loaded by Node at runtime rather than bundled: Prisma's runtime, which
  // reads its WebAssembly query compiler off disk, and the driver adapters
  // with the `pg` and `mariadb` drivers behind them. Externals have to resolve
  // from apps/web, which is why each is a direct dependency here.
  serverExternalPackages: [
    "@prisma/client",
    "@prisma/adapter-pg",
    "@prisma/adapter-mariadb",
    "bcryptjs",
  ],
  experimental: {
    // Server Actions receive device id lists for fleet-wide rollouts.
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default config;
