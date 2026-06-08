import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Static output (default). Cloudflare Pages serves dist/ directly — no adapter needed.
// Canonical domain: joshrutz.com (registered + attached to the personal-site Pages project).
// `site` feeds canonical/OG URLs in Base.astro and the generated sitemap.
export default defineConfig({
  site: 'https://joshrutz.com',
  integrations: [sitemap()],
});
