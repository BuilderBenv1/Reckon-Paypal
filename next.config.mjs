/** @type {import('next').NextConfig} */
const nextConfig = {
  // The engine imports its own TypeScript files with .js extensions (Node ESM style).
  webpack(config) {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
  poweredByHeader: false,
};

export default nextConfig;
