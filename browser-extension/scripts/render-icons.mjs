// Renders the manifest's icons (static/icons/<size>.png) from src/icon.ts,
// the same drawing the worker uses for the badge, in a headless Chromium.
// Run it after changing the icon and commit the PNGs:
//
//   node browser-extension/scripts/render-icons.mjs
//
// Playwright comes from the repo's root node_modules (the site workspace
// depends on it); the build itself does not need it.
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'static', 'icons')
await mkdir(out, { recursive: true })

const bundle = await build({
  stdin: {
    contents: "import { drawIcon } from './src/icon'; globalThis.drawIcon = drawIcon",
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  write: false,
})

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  for (const size of [16, 32, 48, 128]) {
    const dataUrl = await page.evaluate((s) => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = s
      globalThis.drawIcon(canvas.getContext('2d'), s)
      return canvas.toDataURL('image/png')
    }, size)
    await writeFile(join(out, `${size}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'))
  }
} finally {
  await browser.close()
}
