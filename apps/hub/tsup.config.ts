import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Workspace packages ship TypeScript source, so they have to be bundled in
  // rather than resolved at runtime.
  noExternal: ["@magnemite/db", "@magnemite/protocol"],
  // The generated client is bundled with @magnemite/db, but its runtime — and
  // the WebAssembly query compiler that runtime loads — and the two driver
  // adapters stay external, resolved from apps/hub at runtime. That is why all
  // three are direct dependencies here and not only of @magnemite/db.
  external: ["@prisma/client", "@prisma/adapter-pg", "@prisma/adapter-mariadb"],
});
