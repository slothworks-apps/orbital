#!/usr/bin/env node
/**
 * Takes the website's demo posters from the demos themselves (site/CLAUDE.md,
 * "The demo images are screenshots, committed"): each demo is opened at its
 * virtual viewport with `?poster=1`, which holds its scenario on the first
 * beat, and its still is written to `public/demo-images/<id>.webp`. The hero
 * map also gives the page's link preview, `public/og.png`.
 *
 * It builds nothing: run `npm run build:demo` first, so `public/demo` holds
 * the demos as they are now. It serves `public/` itself, on a free local
 * port, so the demos load from the paths they are built for.
 *
 *   npm run build:demo -w @orbital/site && npm run images -w @orbital/site
 *
 * The viewports below must match DEMO_VIEWPORTS in src/demos.ts — the poster
 * stands in for the iframe at that size.
 */
// Node's globals, then the browser's: the functions handed to Playwright run in the page.
/* global URL, Buffer, console, process, window, document, atob, Blob, createImageBitmap */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url))
const OUT = join(PUBLIC, 'demo-images')

/** The demos' still frames: where each is, the size it lays out at, how wide its image is written. */
const SHOTS = [
  { id: 'map-hero', path: '/demo/map/?scene=hero', viewport: { width: 1440, height: 900 }, scale: 2, outWidth: 1440 },
  { id: 'map-states', path: '/demo/map/?scene=states', viewport: { width: 1440, height: 900 }, scale: 2, outWidth: 1440 },
  { id: 'session', path: '/demo/session/', viewport: { width: 1280, height: 800 }, scale: 2, outWidth: 1440 },
  // A phone frame is narrow on the page but drawn on dense screens: twice its width.
  { id: 'phone-answer', path: '/demo/phone/?screen=answer', viewport: { width: 390, height: 844 }, scale: 2, outWidth: 780 },
  { id: 'phone-new', path: '/demo/phone/?screen=new', viewport: { width: 390, height: 844 }, scale: 2, outWidth: 780 },
]

const WEBP_QUALITY = 0.8

/** The link preview: the size the Open Graph cards are drawn at, cut from the hero's still. */
const OG = { from: 'map-hero', width: 1200, height: 630 }

/**
 * How long a demo is left after it says it is ready: the map's planets ease
 * into place and its labels settle over the first moments, and the panels
 * fade in. Generous, since a still taken mid-motion is the one thing to avoid.
 */
const SETTLE_MS = { map: 3000, other: 1200 }

/** What a demo posts to its parent once drawn (DEMO_READY_MESSAGE in src/demos.ts). */
const READY_MESSAGE = 'orbital-demo-ready'

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
}

/** A static server over `public/`, as the site serves it: a directory answers with its index.html. */
function serve(root) {
  const server = createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname)
    let file = normalize(join(root, pathname))
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) {
      res.writeHead(403).end()
      return
    }
    if (pathname.endsWith('/')) file = join(file, 'index.html')
    try {
      const body = await readFile(file)
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body)
    } catch {
      res.writeHead(404).end()
    }
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/**
 * Re-encodes a PNG in the browser, which already has the encoders: scaled to
 * `width` (and to `height`, cropped from the centre, when given), as
 * `type` at `quality`.
 */
async function encode(page, png, { width, height, type, quality }) {
  const dataUrl = await page.evaluate(
    async ({ base64, width, height, type, quality }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      const scale = height ? Math.max(width / bitmap.width, height / bitmap.height) : width / bitmap.width
      const outHeight = height ?? Math.round(bitmap.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = outHeight
      const ctx = canvas.getContext('2d')
      ctx.imageSmoothingQuality = 'high'
      const drawnWidth = bitmap.width * scale
      const drawnHeight = bitmap.height * scale
      ctx.drawImage(bitmap, (width - drawnWidth) / 2, (outHeight - drawnHeight) / 2, drawnWidth, drawnHeight)
      return canvas.toDataURL(type, quality)
    },
    { base64: png.toString('base64'), width, height, type, quality },
  )
  if (!dataUrl.startsWith(`data:${type};`)) throw new Error(`the browser could not encode ${type}`)
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
}

async function main() {
  if (!existsSync(join(PUBLIC, 'demo', 'map', 'index.html'))) {
    console.error('No built demos in public/demo. Run `npm run build:demo -w @orbital/site` first.')
    process.exit(1)
  }
  await mkdir(OUT, { recursive: true })
  const server = await serve(PUBLIC)
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch()
  const encoder = await browser.newPage()
  const stills = new Map()
  let failed = false

  try {
    for (const shot of SHOTS) {
      const context = await browser.newContext({ viewport: shot.viewport, deviceScaleFactor: shot.scale })
      const page = await context.newPage()
      page.on('console', (msg) => {
        if (msg.type() === 'error') console.warn(`  [${shot.id}] console: ${msg.text()}`)
      })
      page.on('pageerror', (err) => console.warn(`  [${shot.id}] page error: ${err.message}`))
      // Opened on its own, the demo is its own parent: it posts the ready message to itself.
      await page.addInitScript((type) => {
        window.addEventListener('message', (event) => {
          if (event.data?.type === type) window.__demoReady = true
        })
      }, READY_MESSAGE)

      const url = `${origin}${shot.path}${shot.path.includes('?') ? '&' : '?'}poster=1`
      await page.goto(url)
      try {
        await page.waitForFunction(() => window.__demoReady === true, null, { timeout: 30_000 })
      } catch {
        console.error(`${shot.id}: never said it was ready (${url})`)
        failed = true
        await context.close()
        continue
      }
      await page.waitForTimeout(shot.id.startsWith('map') ? SETTLE_MS.map : SETTLE_MS.other)
      const png = await page.screenshot({ type: 'png' })
      stills.set(shot.id, png)
      const webp = await encode(encoder, png, { width: shot.outWidth, type: 'image/webp', quality: WEBP_QUALITY })
      await writeFile(join(OUT, `${shot.id}.webp`), webp)
      console.log(`${shot.id}.webp  ${(webp.length / 1024).toFixed(0)} KB`)
      await context.close()
    }

    const hero = stills.get(OG.from)
    if (hero) {
      const og = await encode(encoder, hero, { width: OG.width, height: OG.height, type: 'image/png' })
      await writeFile(join(PUBLIC, 'og.png'), og)
      console.log(`og.png  ${(og.length / 1024).toFixed(0)} KB`)
    }
  } finally {
    await browser.close()
    server.close()
  }
  if (failed) process.exit(1)
}

await main()
