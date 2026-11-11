/* global page, process, fetch, document */
// The App Review video (runbook release-to-the-app-store → Review video): a
// walkthrough of the phone app on staged demo data, posted as one request to
// `store-driver.mjs <dir> --video` so the recording has no gaps. Expects the
// stack from the runbook's Screenshots section, a fresh driver profile (it
// starts at pairing), and two live sessions waiting: a question from
// ledger-api and a permission request from fieldnotes.
const fs = process.getBuiltinModule('fs')
const T = fs.readFileSync('/tmp/orbital-store-demo/data/api-token', 'utf8').trim()
const api = (p, body) =>
  fetch('http://127.0.0.1:4858' + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + T, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json())
const wait = (ms) => page.waitForTimeout(ms)
const tap = async (loc, pause = 1800) => {
  await loc.first().click()
  await wait(pause)
}

// 1. Pairing. The store build scans the QR code; this dev build takes the code's text.
await page.goto('http://localhost:4841')
await page.waitForSelector('#pairing-code')
await wait(3500)
const { qr } = await api('/api/remote/pair', null)
await page.fill('#pairing-code', qr)
await page.waitForFunction(() => document.body.innerText.includes('STEP 2'))
await wait(3000)
const m = (await page.innerText('body')).match(/Type ([A-Z0-9]{3})-([A-Z0-9]{3})/)
const st = await api('/api/remote')
await api('/api/remote/pair/confirm', { accept: true, phone: st.pendingPair.phone, code: m[1] + m[2] })
await page.getByRole('button', { name: 'Open sessions' }).waitFor()
await wait(3000)
await tap(page.getByRole('button', { name: 'Open sessions' }), 1500)
const tip = page.getByRole('button', { name: /^Dismiss/ })
if (await tip.count()) await tap(tip, 1000)
await wait(3000)

// 2. Answer a question.
await tap(page.getByRole('button', { name: /Failed webhook/ }), 3500)
await tap(page.getByRole('button', { name: /Exponential backoff/ }), 1500)
await tap(page.getByRole('button', { name: 'Send answer' }), 7000)
await tap(page.getByRole('button', { name: 'Back to sessions' }), 2500)

// 3. Approve a command.
await tap(page.getByRole('button', { name: /new post is ready|Publish/ }), 3500)
await tap(page.getByRole('button', { name: 'Approve' }), 7000)
await tap(page.getByRole('button', { name: 'Back to sessions' }), 2500)

// 4. Start a new session with background subagents.
await tap(page.getByRole('button', { name: /New session/ }), 2000)
const dirField = page.locator('input[aria-label=Directory]')
await dirField.fill('/Users/Shared/Projects/skycast')
await page.keyboard.press('Escape')
await wait(800)
const worktree = page.getByRole('switch', { name: 'Work in a worktree' })
if ((await worktree.getAttribute('aria-checked')) === 'true') await tap(worktree, 600)
await tap(page.getByRole('radio', { name: 'acceptEdits' }), 500)
await tap(page.getByRole('radio', { name: 'Sonnet 5.5' }), 500)
await page.locator('[aria-label="First prompt"]').click()
await page.keyboard.type(
  'Review the hourly forecast strip before release. Run two background subagents in parallel: one for accessibility, one for gaps in its tests. Then summarize.',
  { delay: 18 },
)
await wait(1200)
await tap(page.getByRole('button', { name: 'Start session' }), 14000)
await tap(page.getByRole('button', { name: 'Back to sessions' }), 5000)

// 5. Settings → About: the privacy policy.
await tap(page.getByRole('button', { name: 'Settings' }), 1500)
await page.getByText('Privacy policy').scrollIntoViewIfNeeded()
await wait(4000)
return 'done'
