import { defineConfig } from 'astro/config';

// Static output (default). Cloudflare Pages serves dist/ directly — no adapter needed.
// `site` is a placeholder until the personal domain is registered.
export default defineConfig({
  site: 'https://personal-site.pages.dev',
});
