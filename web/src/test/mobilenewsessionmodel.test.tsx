import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api, ApiError } from '../lib/api'
import type { OrbitalModel } from '../lib/types'
import { NewSessionModel } from '../mobile/screens/NewSessionModel'

// Spec 2026-11-27-recent-model-cards-design § Phone (canvas 72d). jsdom
// measures nothing, so the row is the canvas's 358 px: two recent cards + Other.

const row = (value: string, shortVersion: string): OrbitalModel => ({
  value, resolvedModel: `claude-${value}`, family: value, version: shortVersion, shortVersion,
  variant: null, blurb: '', contextWindow: 200_000,
})
const MODELS = [row('opus', 'Opus 5.5'), row('sonnet', 'Sonnet 5.5'), row('fable', 'Fable 5.2'), row('haiku', 'Haiku 4.5')]

/** What the screen would launch with: its `model`, set by the field. */
let launched: string | null = 'sonnet'

function Host({ recent = ['sonnet', 'opus', 'fable'] }: { recent?: string[] }) {
  const [value, setValue] = useState<string | null>('sonnet')
  return (
    <NewSessionModel
      models={MODELS} recent={recent} value={value} preselected="sonnet" defaultValue="opus"
      account={null} claudeDirId={null} machine="mac-1" mac="studio" onChange={(next) => {
        launched = next
        setValue(next)
      }}
    />
  )
}

const cards = () => within(screen.getByRole('radiogroup', { name: 'Model' })).getAllByRole('radio')
const other = () => screen.getByRole('button', { name: /^Other model/ })
const openSheet = () => fireEvent.click(other())

beforeEach(() => {
  vi.clearAllMocks()
  launched = 'sonnet'
})

describe('the phone New session model cards', () => {
  it('shows the two newest models and Other', () => {
    render(<Host />)
    expect(cards().map((c) => c.textContent)).toEqual([expect.stringContaining('Sonnet 5.5'), expect.stringContaining('Opus 5.5')])
    expect(other()).toHaveTextContent('Other')
  })

  it('a model from the sheet without a card goes into Other, selected, and is what launches', () => {
    render(<Host />)
    openSheet()
    fireEvent.click(screen.getByRole('option', { name: /Haiku 4.5/ }))
    expect(launched).toBe('haiku')
    expect(other()).toHaveAttribute('aria-pressed', 'true')
    expect(other()).toHaveTextContent('Haiku 4.5')
    expect(cards().every((c) => c.getAttribute('aria-checked') === 'false')).toBe(true)
    // The cards hold still.
    expect(cards().map((c) => c.textContent)).toEqual([expect.stringContaining('Sonnet 5.5'), expect.stringContaining('Opus 5.5')])
  })

  it('a model from the sheet that has a card selects that card', () => {
    render(<Host />)
    openSheet()
    fireEvent.click(screen.getByRole('option', { name: /Opus 5.5/ }))
    expect(launched).toBe('opus')
    expect(cards()[1]).toHaveAttribute('aria-checked', 'true')
    expect(other()).toHaveAttribute('aria-pressed', 'false')
  })

  it('a custom id checked on the chosen device launches as typed', async () => {
    vi.mocked(api.validateModel).mockResolvedValue({ ok: true, model: 'claude-x-1', resolvedModel: null, contextWindow: null })
    render(<Host />)
    openSheet()
    fireEvent.click(screen.getByRole('button', { name: /Custom ID/ }))
    fireEvent.change(screen.getByLabelText('Custom model ID'), { target: { value: ' claude-x-1 ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
    await waitFor(() => expect(launched).toBe('claude-x-1'))
    expect(api.validateModel).toHaveBeenCalledWith('claude-x-1', undefined, 'mac-1')
    expect(other()).toHaveTextContent('CUSTOM ID')
  })

  it('an id the check refuses is not taken', async () => {
    vi.mocked(api.validateModel).mockResolvedValue({ ok: false, model: 'nope', reason: 'There is no such model.' })
    render(<Host />)
    openSheet()
    fireEvent.click(screen.getByRole('button', { name: /Custom ID/ }))
    fireEvent.change(screen.getByLabelText('Custom model ID'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
    expect(await screen.findByText('There is no such model.')).toBeInTheDocument()
    expect(launched).toBe('sonnet')
  })

  it('a check the Mac does not grant says so, and Use again takes the id unchecked', async () => {
    vi.mocked(api.validateModel).mockRejectedValue(new ApiError(JSON.stringify({ error: 'not_granted', grant: 'manage' }), 403))
    render(<Host />)
    openSheet()
    fireEvent.click(screen.getByRole('button', { name: /Custom ID/ }))
    fireEvent.change(screen.getByLabelText('Custom model ID'), { target: { value: 'claude-x-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
    expect(await screen.findByText(/does not let this phone check model IDs/)).toBeInTheDocument()
    expect(launched).toBe('sonnet')
    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
    expect(launched).toBe('claude-x-1')
    expect(api.validateModel).toHaveBeenCalledTimes(1)
  })

  it('a check still out when a model is picked from the sheet never lands', async () => {
    let settle: (v: Awaited<ReturnType<typeof api.validateModel>>) => void = () => {}
    vi.mocked(api.validateModel).mockImplementation(() => new Promise((r) => (settle = r)))
    render(<Host />)
    openSheet()
    fireEvent.click(screen.getByRole('button', { name: /Custom ID/ }))
    fireEvent.change(screen.getByLabelText('Custom model ID'), { target: { value: 'claude-late-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
    fireEvent.click(screen.getByRole('option', { name: /Opus 5.5/ }))
    expect(launched).toBe('opus')
    await act(async () => {
      settle({ ok: true, model: 'claude-late-1', resolvedModel: null, contextWindow: null })
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(launched).toBe('opus')
  })

  it('a refusal names the grant the Mac asks for', async () => {
    vi.mocked(api.validateModel).mockRejectedValue(new ApiError(JSON.stringify({ error: 'not_granted', grant: 'spawn' }), 403))
    render(<Host />)
    openSheet()
    fireEvent.click(screen.getByRole('button', { name: /Custom ID/ }))
    fireEvent.change(screen.getByLabelText('Custom model ID'), { target: { value: 'claude-x-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
    expect(await screen.findByText(/Start sessions/)).toBeInTheDocument()
  })

  it('with no history from an older Mac, the default comes first', () => {
    render(<Host recent={[]} />)
    expect(cards().map((c) => c.textContent)).toEqual([expect.stringContaining('Opus 5.5'), expect.stringContaining('Sonnet 5.5')])
  })
})
