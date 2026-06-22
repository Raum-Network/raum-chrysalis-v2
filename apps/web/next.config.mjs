import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const nobleCurvesV1 = path.join(repoRoot, "node_modules/.pnpm/@noble+curves@1.9.7/node_modules/@noble/curves");
const nobleHashesV1 = path.join(repoRoot, "node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes");

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@arc-os/sdk"],
  webpack: (config, { dev }) => {
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@noble/curves/ed25519": path.join(nobleCurvesV1, "esm/ed25519.js"),
      "@noble/curves/secp256k1": path.join(nobleCurvesV1, "esm/secp256k1.js"),
      "@noble/hashes/sha256": path.join(nobleHashesV1, "esm/sha256.js"),
      "@noble/hashes/sha3": path.join(nobleHashesV1, "esm/sha3.js")
    };

    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: /node_modules|contracts|programs|\.git|\.next/
      };
    }
    return config;
  }
};
export default nextConfig;

