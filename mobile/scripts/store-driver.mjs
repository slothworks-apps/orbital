// App Store screenshots (runbook release-to-the-app-store → Screenshots): a
// WebKit page shaped like an iPhone 17 Pro Max (440×956 at 3×, the 6.9-inch
// 1320×2868 set), driven over HTTP so a session can click and shoot step by
// step. POST /  body = an async function body with `page` in scope; returns
// its JSON result. The profile in <dir>/webkit keeps the phone's pairing.
// Usage: node mobile/scripts/store-driver.mjs [dir]   (default /tmp/orbital-store-demo)
import http from 'node:http'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const dir = process.argv[2] ?? '/tmp/orbital-store-demo'
const { webkit } = require('playwright')

const ctx = await webkit.launchPersistentContext(`${dir}/webkit`, {
  viewport: { width: 440, height: 956 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
})
const page = ctx.pages()[0] ?? (await ctx.newPage())
page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()))

http
  .createServer((req, res) => {
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
  .listen(4880, () => console.log('driver on 4880'))
