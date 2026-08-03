import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // sharp is a native module; keep it out of the Next server bundle so the
  // Next server process never loads the native binary (crop_image/generate_image
  // adapters `import("sharp")` lazily inside `execute`, not at module scope).
  serverExternalPackages: ["sharp"],
};

export default nextConfig;
