import type { Meta, StoryObj } from '@storybook/react-vite'
import { VIEW_BUILTIN_CDN_HOSTS, VIEW_TOOL, type ViewPayload } from '@orbital/shared/views'
import { configureViewSource } from '../lib/views/source'
import { useOrbital } from '../store/store'
import { ViewFrame } from './ViewFrame'

/**
 * A generated view in each of its states (canvas `Feature - Views` 69b, 69c),
 * drawn from a fake source: the component below is what the Mac's compiler
 * hands over — JSX gone, imports kept.
 */

const MONTHS = [['Jan', 182], ['Feb', 176], ['Mar', 201], ['Apr', 168], ['May', 159], ['Jun', 212], ['Jul', 174]]

const CHART = `import { useState } from 'react'
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime'
export default function View({ data }) {
  const [sel, setSel] = useState([])
  const pick = data.pick
  const toggle = (i) => setSel(sel.includes(i) ? sel.filter((x) => x !== i) : [...sel, i])
  return _jsxs('div', { className: 'flex h-full flex-col gap-2.5 px-4 py-3.5', children: [
    _jsxs('div', { className: 'flex items-baseline gap-2.5', children: [
      _jsx('span', { className: 'fs-13 font-bold', children: 'p95 latency by month' }),
      _jsx('span', { className: 'font-mono fs-10 text-ink-900/60', children: 'ms · api-gateway' }),
    ] }),
    _jsx('div', { className: 'flex h-[110px] items-end gap-2 border-b border-line/16 px-0.5', children: data.months.map(([m, v], i) =>
      _jsxs('div', { onClick: () => pick && toggle(i), className: 'flex h-full flex-1 cursor-pointer flex-col items-center justify-end gap-1', children: [
        _jsx('span', { className: 'font-mono fs-10 text-ink-900/60', children: v }),
        _jsx('span', { className: 'w-full rounded-t-[3px] ' + (sel.includes(i) ? 'bg-accent' : pick ? 'bg-accent/35' : 'bg-accent/60'), style: { height: Math.round((v / 230) * 92) } }),
      ] }, m)) }),
    pick && _jsxs('div', { className: 'mt-auto flex items-center gap-2.5', children: [
      _jsx('span', { className: 'flex-1 fs-12 text-ink-200/80', children: sel.length ? sel.map((i) => data.months[i][0]).join(', ') + ' selected' : 'Pick the months to compare' }),
      _jsx('button', { type: 'submit', disabled: !sel.length, onClick: () => orbital.send(sel.map((i) => data.months[i][0])), children: 'Send ' + sel.length + ' months' }),
    ] }),
  ] })
}`

const THROWS = `export default function View({ data }) { return data.missing.map((x) => x) }`

const TALL = `<h1>Endpoints over 150 ms</h1><table><tr><th>ENDPOINT</th><th>P95</th></tr>${Array.from(
  { length: 30 },
  (_, i) => `<tr><td>GET /v1/route-${i}</td><td>${120 + i * 7} ms</td></tr>`,
).join('')}</table>`

function payload(over: Partial<ViewPayload>): ViewPayload {
  return {
    viewId: 'v1',
    toolUseId: 'v1',
    title: 'Release latency',
    kind: 'react',
    script: CHART,
    height: 230,
    wait: false,
    liveDomains: [],
    data: { format: 'inline', bytes: 0, inline: true, value: { months: MONTHS, pick: false } },
    approvedDomains: [],
    cdnHosts: [...VIEW_BUILTIN_CDN_HOSTS],
    waiting: false,
    result: null,
    ...over,
  }
}

/** Points the frame at one payload, and the session at a waiting decision when it waits. */
function seed(view: ViewPayload): () => () => void {
  return () => {
    configureViewSource({ payload: () => Promise.resolve(view), data: () => Promise.resolve('null') })
    const before = useOrbital.getState().pendingDecisions
    if (view.waiting) {
      useOrbital.setState({
        pendingDecisions: {
          s1: { id: view.toolUseId, kind: 'view', toolName: VIEW_TOOL, title: view.title, input: { viewId: view.viewId, title: view.title }, createdAt: Date.now() },
        },
      })
    }
    return () => {
      configureViewSource(null)
      useOrbital.setState({ pendingDecisions: before })
    }
  }
}

const meta = {
  title: 'Panels/ViewFrame',
  component: ViewFrame,
  args: { sessionId: 's1', toolUseId: 'v1', surface: 'panel', onMaximise: () => {} },
  decorators: [(Story) => <div style={{ width: 406 }}>{Story()}</div>],
} satisfies Meta<typeof ViewFrame>

export default meta
type Story = StoryObj<typeof meta>

export const Live: Story = { beforeEach: seed(payload({})) }

export const AskingToFetch: Story = {
  beforeEach: seed(payload({ liveDomains: ['api.github.com', 'api.example.org'] })),
}

export const WaitingForYou: Story = {
  beforeEach: seed(payload({ wait: true, waiting: true, data: { format: 'inline', bytes: 0, inline: true, value: { months: MONTHS, pick: true } } })),
}

export const Sent: Story = {
  beforeEach: seed(payload({ wait: true, result: { viewId: 'v1', outcome: 'sent', value: ['Jan', 'Mar', 'Jul'] } })),
  args: { resultAt: new Date().toISOString() },
}

export const PageThrew: Story = { beforeEach: seed(payload({ script: THROWS })) }

export const PlainPageScrollsInside: Story = {
  beforeEach: seed(payload({ kind: 'html', script: undefined, html: TALL, height: 480, title: 'Slow endpoints' })),
}

export const Phone: Story = { beforeEach: seed(payload({})), args: { surface: 'phone' } }
