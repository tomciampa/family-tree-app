import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Next's default is 1MB, which real scanned certificates and phone
      // photos routinely exceed — that's what was causing document
      // uploads to fail server-side (a 413) while the client-side upload
      // form had no error handling for it, so the UI just hung on
      // "Uploading…" forever. 10MB comfortably covers real scans/photos
      // without being unreasonably permissive.
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
