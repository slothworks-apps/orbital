import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Which server this dev frontend talks to. `npm run dev` exports 4838 so the
 * edit loop cannot reach the dogfood instance on 4737 — a save restarts the
 * dev server, and a restart kills every session that server is running
 * (docs/ops/dogfood-and-dev-side-by-side.md). The 4737 default stands for
 * anyone starting vite by hand against a plain server.
 */
const SERVER_PORT = process.env.ORBITAL_PORT ?? '4737'

// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    // `DEV_WEB_PORT` in server/src/index.ts, the one web origin the server's
    // socket accepts besides its own. Strict: a taken port fails here, loudly,
    // instead of vite moving on to one whose socket is refused.
    port: 4839,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${SERVER_PORT}`,
      '/ws': { target: `ws://127.0.0.1:${SERVER_PORT}`, ws: true },
    },
  },
})
