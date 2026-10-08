import { defineConfig } from 'astro/config'
import react from '@astrojs/react'
import sitemap from '@astrojs/sitemap'
import { SITE_URL } from './src/site.ts'

// The demos are framed by the landing page and carry noindex; listing them
// in the sitemap would ask crawlers for pages we tell them not to index.
const isDemo = (page) => page.startsWith(`${SITE_URL}/demo/`)

export default defineConfig({
  site: SITE_URL,
  output: 'static',
  trailingSlash: 'always',
  integrations: [react(), sitemap({ filter: (page) => !isDemo(page) })],
  vite: {
    environments: {
      prerender: {
        resolve: {
          // Astro needs cookie 2 and has it nested under its own node_modules,
          // while the workspace root hoists cookie 0.7 for the server. Left
          // external, the prerender bundle (run from dist/) resolves the
          // hoisted one and fails; bundling it pins the one Astro resolved.
          noExternal: ['cookie'],
        },
      },
    },
  },
})
