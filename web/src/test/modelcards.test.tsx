import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ModelCards } from '../ui/ModelCards'
import type { OrbitalModel } from '../lib/types'

const MODELS: OrbitalModel[] = [
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', family: 'Opus', version: 'Opus 5 with 1M context', shortVersion: 'Opus 5', variant: '1M', blurb: 'Best for everyday, complex tasks', contextWindow: 1_000_000 },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', family: 'Sonnet', version: 'Sonnet 5', shortVersion: 'Sonnet 5', variant: null, blurb: 'Efficient for routine tasks', contextWindow: 200_000 },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', family: 'Haiku', version: 'Haiku 4.5', shortVersion: 'Haiku 4.5', variant: null, blurb: 'Fastest for quick answers', contextWindow: null },
]

describe('ModelCards', () => {
  it('shows the context window when known and nothing when not', () => {
    render(<ModelCards models={MODELS} value="sonnet" onChange={() => {}} />)
    expect(screen.getByText('1M CTX')).toBeInTheDocument()
    expect(screen.getByText('200K CTX')).toBeInTheDocument()
    expect(screen.queryByText(/null/i)).not.toBeInTheDocument()
  })

  it('shows the context window on compact cards too', () => {
    render(<ModelCards compact models={MODELS} value="sonnet" onChange={() => {}} />)
    expect(screen.getByRole('radio', { name: 'Opus 5' })).toHaveTextContent('1M ctx')
    // Unknown size: the second line is absent, not "null ctx".
    expect(screen.getByRole('radio', { name: 'Haiku 4.5' })).not.toHaveTextContent('ctx')
  })

  it('marks the settings default', () => {
    render(<ModelCards models={MODELS} value="opus[1m]" defaultValue="sonnet" onChange={() => {}} />)
    expect(screen.getByText('DEFAULT')).toBeInTheDocument()
  })

  it('does not mark the default when it is also the selection', () => {
    render(<ModelCards models={MODELS} value="sonnet" defaultValue="sonnet" onChange={() => {}} />)
    expect(screen.queryByText('DEFAULT')).not.toBeInTheDocument()
  })

  it('reports the chosen value', () => {
    const onChange = vi.fn()
    render(<ModelCards models={MODELS} value="sonnet" onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Haiku 4.5' }))
    expect(onChange).toHaveBeenCalledWith('haiku')
  })

  it('explains itself when the catalog is empty', () => {
    render(<ModelCards models={[]} value={null} onChange={() => {}} />)
    expect(screen.getByText(/could not be read/i)).toBeInTheDocument()
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
  })
})
