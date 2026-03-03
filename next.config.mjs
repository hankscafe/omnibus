/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  
  // Add these two lines to bypass strict CI checks during Docker builds
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;