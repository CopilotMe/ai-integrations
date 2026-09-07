import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The admin UI is an internal tool: it must never be indexed, framed, or
  // leak referrers to the systems it links out to.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default config;
