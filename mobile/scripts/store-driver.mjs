// App Store screenshots (runbook release-to-the-app-store → Screenshots): a
// WebKit page shaped like an iPhone 17 Pro Max (440×956 at 3×, the 6.9-inch
// 1320×2868 set), driven over HTTP so a session can click and shoot step by
// step. POST /  body = an async function body with `page` in scope; returns
// its JSON result. The profile in <dir>/webkit keeps the phone's pairing.
// The body runs as Node code, so the server binds to loopback only and takes
// a request only with the token it writes to <dir>/driver-token at start, in
// an `x-driver-token` header: a web page can neither read the token nor send
// that header without a preflight the server never answers.
// With `--video`, the page is recorded to <dir>/video (WebM, written when the
// context closes: POST `await page.context().close()`), and store-iphone.js
// is applied to every frame instead of before each screenshot.
// Usage: node mobile/scripts/store-driver.mjs [dir] [--video]   (default /tmp/orbital-store-demo)
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const video = args.includes('--video')
const dir = args.find((a) => !a.startsWith('--')) ?? '/tmp/orbital-store-demo'
const { webkit } = require('playwright')
const token = randomBytes(24).toString('hex')
mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}/driver-token`, token, { mode: 0o600 })
const authorized = (req) => {
  const got = Buffer.from(String(req.headers['x-driver-token'] ?? ''))
  return req.method === 'POST' && got.length === token.length && timingSafeEqual(got, Buffer.from(token))
}

const ctx = await webkit.launchPersistentContext(`${dir}/webkit`, {
  viewport: { width: 440, height: 956 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  ...(video ? { recordVideo: { dir: `${dir}/video`, size: { width: 880, height: 1912 } } } : {}),
})
if (video) {
  // Vite adds stylesheets as modules load, so the safe areas are applied again until the page settles.
  const iphone = readFileSync(new URL('./store-iphone.js', import.meta.url), 'utf8')
  await ctx.addInitScript(`addEventListener('DOMContentLoaded', () => setInterval(() => { ${iphone} }, 200))`)
}
const page = ctx.pages()[0] ?? (await ctx.newPage())
page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()))

http
  .createServer((req, res) => {
    if (!authorized(req)) {
      res.statusCode = 403
      res.end()
      req.resume()
      return
    }
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', async () => {
      try {
        const fn = new Function('page', `return (async () => { ${body} })()`)
        const out = await fn(page)
        res.end(JSON.stringify(out ?? null))
      } catch (e) {
        res.statusCode = 500
        res.end(String(e?.stack ?? e))
      }
    })
  })
  .listen(4880, '127.0.0.1', () => console.log(`driver on 127.0.0.1:4880, token in ${dir}/driver-token`))
