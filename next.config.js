/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['@prisma/client'],
    instrumentationHook: true,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'avatars.githubusercontent.com' },
      { protocol: 'https', hostname: 'cdn.discordapp.com' },
    ],
  },
  webpack: (config, { isServer }) => {
    // 7z-wasm (src/lib/archiveExtract.ts's 7z/RAR support) ships one build
    // that detects Node vs. browser at RUNTIME and branches accordingly —
    // standard for an Emscripten-generated dual-environment module. The
    // Node branch (`await import('module')`, plus fs/path/url) never
    // actually executes in a browser (guarded by a real `typeof process`
    // check), but webpack 5 doesn't polyfill Node core modules for
    // client bundles by default anymore, and can't statically prove that
    // runtime branch dead ahead of time — so without this, it fails at
    // BUILD time trying to resolve modules that are only ever reached in
    // a Node context. `false` tells webpack "these aren't available, and
    // that's fine" rather than trying to resolve or polyfill them.
    // Server-side bundles need no such fallback (Node natively has all of
    // these), so this only applies when !isServer.
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        module: false,
        fs: false,
        path: false,
        url: false,
      };
    }
    return config;
  },
};

module.exports = nextConfig;
