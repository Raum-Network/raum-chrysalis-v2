/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@arc-os/sdk"],
  webpack: (config, { dev }) => {
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


