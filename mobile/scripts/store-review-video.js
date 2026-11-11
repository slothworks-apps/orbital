/* global page, process, fetch, document, requestAnimationFrame, setTimeout */
// The App Review video (runbook release-to-the-app-store → Review video): a
// walkthrough of the phone app on staged demo data, posted as one request to
// `store-driver.mjs <dir> --video` so the recording has no gaps. Expects the
// stack from the runbook's Screenshots section, a fresh driver profile (it
// starts at pairing), and two live sessions waiting: a question from
// ledger-api and a permission request from fieldnotes.
//
// A recording has no finger: every tap first shows a touch mark where it
// lands. After an action the walkthrough waits for the session to answer
// (its status on the Mac leaves `working`) and holds on the answer before it
// moves on, so a viewer sees what the action did.
const fs = process.getBuiltinModule('fs')
const T = fs.readFileSync('/tmp/orbital-store-demo/data/api-token', 'utf8').trim()
const api = (p, body) =>
  fetch('http://127.0.0.1:4858' + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + T, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json())
const wait = (ms) => page.waitForTimeout(ms)

/** The touch mark: a soft disc that presses in where the tap lands, then fades. */
const mark = (x, y) =>
  page.evaluate(
    ([x, y]) => {
      const dot = document.createElement('div')
      dot.style.cssText = `position:fixed;left:${x - 26}px;top:${y - 26}px;width:52px;height:52px;border-radius:50%;
        background:rgba(255,255,255,.28);border:2px solid rgba(255,255,255,.75);z-index:2147483647;pointer-events:none;
        transform:scale(1.35);opacity:0;transition:transform .35s ease-out,opacity .2s ease-out`
      document.body.appendChild(dot)
      requestAnimationFrame(() => {
        dot.style.opacity = '1'
        dot.style.transform = 'scale(.85)'
      })
      setTimeout(() => {
        dot.style.transition = 'opacity .45s ease-in'
        dot.style.opacity = '0'
      }, 650)
      setTimeout(() => dot.remove(), 1200)
    },
    [x, y],
  )

/** Shows the touch mark on the element, then taps it, then lets the screen settle. */
const tap = async (loc, pause = 2200) => {
  const el = loc.first()
  await el.scrollIntoViewIfNeeded()
  const box = await el.boundingBox()
  await mark(box.x + box.width / 2, box.y + box.height / 2)
  await wait(500)
  await el.click()
  await wait(pause)
}

const sessionId = async (title) => {
  const j = await api('/api/sessions')
  return (j.sessions ?? j).find((s) => s.status !== 'ended' && title.test(s.title ?? ''))?.id
}
const status = async (id) => (await api('/api/sessions/' + id)).session?.status

/** Waits until the session has started and finished answering, then holds on the answer. */
const answered = async (id, hold = 5000) => {
  for (let i = 0; i < 20 && (await status(id)) !== 'working'; i++) await wait(500)
  for (let i = 0; i < 120 && (await status(id)) === 'working'; i++) await wait(500)
  await wait(hold)
}

const question = await sessionId(/^Failed webhook/)
const permission = await sessionId(/new post is ready|Publish/)

// 1. Pairing. The store build scans the QR code; this dev build takes the code's text.
await page.goto('http://localhost:4841')
await page.waitForSelector('#pairing-code')
await wait(4000)
const { qr } = await api('/api/remote/pair', null)
await page.fill('#pairing-code', qr)
await page.waitForFunction(() => document.body.innerText.includes('STEP 2'))
await wait(3500)
const m = (await page.innerText('body')).match(/Type ([A-Z0-9]{3})-([A-Z0-9]{3})/)
const st = await api('/api/remote')
await api('/api/remote/pair/confirm', { accept: true, phone: st.pendingPair.phone, code: m[1] + m[2] })
await page.getByRole('button', { name: 'Open sessions' }).waitFor()
await wait(3500)
await tap(page.getByRole('button', { name: 'Open sessions' }), 2000)
const tip = page.getByRole('button', { name: /^Dismiss/ })
if (await tip.count()) await tap(tip, 1500)
await wait(3500)

// 2. Answer a question.
await tap(page.getByRole('button', { name: /Failed webhook/ }), 4000)
await tap(page.getByRole('button', { name: /Exponential backoff/ }), 1800)
await tap(page.getByRole('button', { name: 'Send answer' }), 500)
await answered(question, 9000)
await tap(page.getByRole('button', { name: 'Back to sessions' }), 3000)

// 3. Approve a command.
await tap(page.getByRole('button', { name: /new post is ready|Publish/ }), 4000)
await tap(page.getByRole('button', { name: 'Approve' }), 500)
await answered(permission, 9000)
await tap(page.getByRole('button', { name: 'Back to sessions' }), 3000)

// 4. Start a new session with background subagents.
await tap(page.getByRole('button', { name: /New session/ }), 2500)
const dirField = page.locator('input[aria-label=Directory]')
await tap(dirField, 300)
await dirField.fill('/Users/Shared/Projects/skycast')
await page.keyboard.press('Escape')
await wait(1200)
const worktree = page.getByRole('switch', { name: 'Work in a worktree' })
if ((await worktree.getAttribute('aria-checked')) === 'true') await tap(worktree, 800)
await tap(page.getByRole('radio', { name: 'acceptEdits' }), 800)
await tap(page.getByRole('radio', { name: 'Sonnet 5.5' }), 800)
await tap(page.locator('[aria-label="First prompt"]'), 300)
await page.keyboard.type(
  'Review the hourly forecast strip before release. Run two background subagents in parallel: one for accessibility, one for gaps in its tests. Then summarize.',
  { delay: 30 },
)
await wait(1800)
await tap(page.getByRole('button', { name: 'Start session' }), 500)
// The session works while its subagents run: hold on it until they show, then on the list.
await page.waitForFunction(() => /\bsubagents?\b|Agent/.test(document.body.innerText), null, { timeout: 60000 })
await wait(10000)
await tap(page.getByRole('button', { name: 'Back to sessions' }), 8000)

// 5. Settings → About: the privacy policy.
await tap(page.getByRole('button', { name: 'Settings' }), 2000)
const privacy = page.getByText('Privacy policy')
await privacy.scrollIntoViewIfNeeded()
await wait(1500)
const box = await privacy.boundingBox()
await mark(box.x + box.width / 2, box.y + box.height / 2)
await wait(5000)
return 'done'
