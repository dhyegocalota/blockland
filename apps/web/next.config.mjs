/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  experimental: {
    serverComponentsExternalPackages: ['@libsql/client', 'libsql'],
  },
};

export default nextConfig;
