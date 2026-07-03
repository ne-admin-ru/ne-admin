import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';

export default defineConfig({
  site: 'https://ne-admin-ru.github.io',
  base: '/ne-admin',
  integrations: [mdx()],
  markdown: {
    shikiConfig: {
      theme: 'github-dark'
    }
  }
});
