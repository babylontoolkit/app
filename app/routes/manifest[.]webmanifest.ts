/**
 * PWA manifest — served from a route, never a static `public/manifest.json`, so every brand-shaped
 * string (name, description) comes from the brand module and nothing is hardcoded (SPEC §2.3, §2.5;
 * CLAUDE.md "Branding rule": "nothing brand-shaped is ever hardcoded in a … PWA manifest").
 *
 * Served at `/manifest.webmanifest` (the `[.]` in the filename escapes the dot). Icons and colors point
 * at existing `public/` assets; swapping visual identity is a change to `brand.assets` + those files.
 */
import { json } from '@remix-run/cloudflare';
import { brand } from '~/config/brand';

export function loader() {
  const manifest = {
    name: brand.productFullName,
    short_name: brand.productName,
    description: brand.metaDescription,
    start_url: '/',
    display: 'standalone',
    background_color: '#0a0a0a',
    theme_color: '#0a0a0a',
    icons: [
      { src: brand.assets.favicon, sizes: '48x48', type: 'image/x-icon' },
      { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
      { src: brand.assets.logo, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };

  return json(manifest, {
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
