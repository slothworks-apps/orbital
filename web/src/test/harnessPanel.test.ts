import { describe, expect, it } from 'vitest'
import { foldFile, parsePatch } from '../panels/harness/patch'
import { recordMarkdown } from '../panels/harness/markdown'
import { railItems, stepKind } from '../panels/harness/model'
import { DEFAULT_HARNESS_OPTIONS, type HarnessEvent, type HarnessStep, type SessionHarness } from '../lib/types'

const PATCH = `diff --git a/packages/ui/Button/Button.tsx b/packages/ui/Button/Button.tsx
index 1111111..2222222 100644
--- a/packages/ui/Button/Button.tsx
+++ b/packages/ui/Button/Button.tsx
@@ -41,4 +41,6 @@ export function Button({
   const cls = cx(styles.root, styles[variant]);
-  if (loading) return <Spinner />;
+  if (loading) {
+    return <span className={cls} aria-busy="true" />;
+  }
   return (
\\ No newline at end of file
diff --git a/docs/parity/Button.md b/docs/parity/Button.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/docs/parity/Button.md
@@ -0,0 +1,2 @@
+# Parity
+
diff --git a/old.css b/old.css
deleted file mode 100644
--- a/old.css
+++ /dev/null
@@ -1,1 +0,0 @@
-.x {}
diff --git a/a.ts b/b.ts
similarity index 90%
rename from a.ts
rename to b.ts
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
… (cut — run git diff 3f9c21a..8be04d7)
`

describe('parsePatch', () => {
  const parsed = parsePatch(PATCH)

  it('splits the patch into files with their own counts', () => {
    expect(parsed.files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([
      ['packages/ui/Button/Button.tsx', 'modified', 3, 1],
      ['docs/parity/Button.md', 'added', 2, 0],
      ['old.css', 'deleted', 0, 1],
      ['b.ts', 'renamed', 0, 0],
      ['logo.png', 'modified', 0, 0],
    ])
    expect(parsed.files[3].oldPath).toBe('a.ts')
    expect(parsed.files[4].binary).toBe(true)
    expect([parsed.added, parsed.removed, parsed.cut]).toEqual([5, 2, true])
  })

  it('numbers a removed line by the old file and the rest by the new one', () => {
    const lines = parsed.files[0].hunks[0].lines
    expect(lines.map((l) => [l.kind, l.line])).toEqual([
      ['context', 41],
      ['del', 42],
      ['add', 42],
      ['add', 43],
      ['add', 44],
      ['context', 45],
    ])
    // A blank added line keeps its place; "\ No newline" is not a line.
    expect(parsed.files[1].hunks[0].lines.map((l) => l.text)).toEqual(['# Parity', ''])
  })

  it('folds a long file after a number of lines, keeping the count of the rest', () => {
    const { hunks, more } = foldFile(parsed.files[0], 2)
    expect(hunks[0].lines).toHaveLength(2)
    expect(more).toBe(4)
  })
})

const step = (id: string, mode: 'auto' | 'gate', title = id): HarnessStep => ({ id, title, instructions: 'do it', mode, doneWhen: 'done' })

const base: SessionHarness = {
  sessionId: 's1',
  templateId: 1,
  name: 'Build a component',
  steps: [step('load', 'auto', 'Load the design'), step('stories', 'gate', 'Stories'), step('parity', 'gate', 'Parity')],
  inputs: { component: 'Button' },
  state: [
    { status: 'done', completedAt: 1_000, summary: 'Loaded.' },
    {
      status: 'done',
      completedAt: 3_000,
      approvedBy: 'reviewer',
      openQuestions: ['Ring 2 px or 3 px?'],
      reviews: [
        { at: 2_500, verdict: 'reopen', uncertain: false, reasoning: 'No loading story.', checked: [], findings: [] },
        { at: 3_000, verdict: 'approve', uncertain: true, reasoning: 'Ring width is your call.', checked: ['24 stories'], findings: ['ring'] },
      ],
    },
    { status: 'awaiting_approval', summary: 'Parity table written.' },
  ],
  options: DEFAULT_HARNESS_OPTIONS,
  paused: false,
  pauseReason: null,
  pauseKind: null,
  pausedAt: null,
  removedAt: null,
  autoRounds: 0,
  idleNudges: 0,
  createdAt: 500,
  updatedAt: 0,
}

let nextId = 1
const ev = (at: number, kind: HarnessEvent['kind'], detail: Record<string, unknown> = {}): HarnessEvent => ({
  id: nextId++,
  sessionId: 's1',
  at,
  kind,
  detail,
})

describe('stepKind', () => {
  it('reads who finished a step and what a live one is waiting for', () => {
    const kinds = base.steps.map((s, i) => stepKind(s, base.state[i], base))
    expect(kinds).toEqual(['doneAgent', 'doneUnsure', 'waiting'])
    expect(stepKind(base.steps[2], { status: 'awaiting_approval', reviewing: true }, base)).toBe('reviewing')
    expect(stepKind(base.steps[1], { status: 'done', approvedBy: 'user' }, base)).toBe('doneYou')
    expect(stepKind(base.steps[2], { status: 'pending' }, base)).toBe('pendingGate')
  })

  it('tells sent back, reopened by the user and paused apart from plain work', () => {
    const sentBack = { status: 'active' as const, reviews: [base.state[1].reviews![0]] }
    expect(stepKind(base.steps[1], sentBack, base)).toBe('sentBack')
    expect(stepKind(base.steps[1], sentBack, { paused: true })).toBe('pausedHere')
    const reopened = [ev(10, 'advanced', { step: 'stories' }), ev(20, 'reopened', { step: 'stories' })]
    expect(stepKind(base.steps[1], { status: 'active' }, base, reopened)).toBe('reopened')
    // Sent on again after the reopen: plain work.
    expect(stepKind(base.steps[1], { status: 'active' }, base, [...reopened, ev(30, 'advanced', { step: 'stories' })])).toBe('active')
  })
})

describe('railItems', () => {
  it('puts the harness’s own events after the step current when they happened', () => {
    const events = [
      ev(400, 'paused', { by: 'user' }), // an earlier harness's, before this one began
      ev(500, 'attached', { scope: { kind: 'global' } }),
      ev(2_000, 'paused', { by: 'user' }),
      ev(2_100, 'resumed', { by: 'user' }),
      ev(4_000, 'paused', { by: 'harness', kind: 'nudge_cap' }),
    ]
    const items = railItems(base, events).map((i) => (i.kind === 'step' ? i.index : i.text.split(' · ')[0]))
    expect(items).toEqual(['started', 0, 1, 'paused by you', 'resumed', 2, 'paused'])
  })
})

describe('recordMarkdown', () => {
  it('exports the steps with their records and the events in order', () => {
    const events = [
      ev(500, 'attached', { scope: { kind: 'global' } }),
      ev(600, 'advanced', { step: 'load', index: 0 }),
      ev(1_000, 'ticked', { step: 'load', index: 0, verify: 'passed', gate: false }),
      ev(2_500, 'reviewed', { step: 'stories', index: 1, verdict: 'reopen', uncertain: false }),
      ev(3_000, 'reviewed', { step: 'stories', index: 1, verdict: 'approve', uncertain: true }),
    ]
    const md = recordMarkdown(base, events)
    const order = ['# Build a component', '— started', '## 01 · ● Load the design', 'Loaded.', 'ticked · verify passed', '## 02 · ◆ Stories', '- ◇ Ring 2 px or 3 px?', 'sent back: No loading story.', 'approved, unsure: Ring width is your call.', 'reviewer approved, unsure', '## 03 · ◆ Parity', 'needs your OK']
    let at = -1
    for (const piece of order) {
      const next = md.indexOf(piece, at + 1)
      expect(next, piece).toBeGreaterThan(at)
      at = next
    }
  })
})
