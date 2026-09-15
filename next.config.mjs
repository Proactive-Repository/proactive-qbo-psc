/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    return [
      { source: "/.well-known/oauth-authorization-server", destination: "/api/oauth/metadata" },
      { source: "/.well-known/oauth-authorization-server/:path*", destination: "/api/oauth/metadata" },
      { source: "/.well-known/oauth-protected-resource", destination: "/api/oauth/resource" },
      { source: "/.well-known/oauth-protected-resource/:path*", destination: "/api/oauth/resource" },
    ];
  },
  async headers() {
    return [
      {
        source: "/api/oauth/:path*",
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }, { key: "Access-Control-Allow-Headers", value: "content-type, authorization, mcp-protocol-version" }, { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" }],
      },
      {
        source: "/.well-known/:path*",
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }, { key: "Access-Control-Allow-Headers", value: "content-type, authorization, mcp-protocol-version" }],
      },
    ];
  },
};
export default nextConfig;
