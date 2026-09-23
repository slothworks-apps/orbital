import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WhereLine } from '../panels/WhereLine'

const LONG = 'feature/interactive-decisions-and-questions'

const MAIN = { ref: 'main', detached: false, worktree: false, defaultBranch: true }

function renderLine(git: typeof MAIN, panelWidthPx = 360) {
  return render(
    <WhereLine
      path="~/…/slothworks/orbital"
      fullPath="/Users/tomin/Projects/slothworks/orbital"
      git={git}
      sessionId="s1"
      panelWidthPx={panelWidthPx}
    />,
  )
}

describe('WhereLine', () => {
  it('shows the whole branch name on hover once it has been cut', () => {
    // The native `title` attribute is not enough: it is drawn by the OS, and
    // in the Electron shell it does not appear at all.
    const { container } = renderLine({ ...MAIN, ref: LONG, defaultBranch: false })
    const shown = container.textContent ?? ''
    expect(shown).not.toContain(LONG)

    const trigger = screen.getByTestId('git-reading')
    fireEvent.mouseEnter(trigger)
    expect(screen.getByRole('tooltip')).toHaveTextContent(LONG)

    fireEvent.mouseLeave(trigger)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('hangs the bubble outside anything that clips overflow', () => {
    // The bubble drops below a 28px row. An ancestor with `overflow: hidden`
    // therefore cuts away all of it, and the row renders as though nothing
    // happened — which is exactly what shipped. jsdom lays nothing out and
    // clips nothing, so the only guard is the structure itself.
    const { container } = renderLine({ ...MAIN, ref: LONG, defaultBranch: false })
    fireEvent.mouseEnter(screen.getByTestId('git-reading'))
    const tip = screen.getByRole('tooltip')

    const clipping: string[] = []
    for (let el = tip.parentElement; el && el !== container; el = el.parentElement) {
      if (el.className.includes('overflow-hidden')) clipping.push(el.className)
    }
    expect(clipping).toEqual([])
  })

  it('stays silent on hover when the whole branch is already on screen', () => {
    renderLine(MAIN, 900)
    fireEvent.mouseEnter(screen.getByTestId('git-reading'))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('reads out the kind, the branch and the full path', () => {
    renderLine({ ref: 'tray-mode', detached: false, worktree: true, defaultBranch: false })
    expect(
      screen.getByLabelText('Worktree · branch tray-mode · /Users/tomin/Projects/slothworks/orbital'),
    ).toBeInTheDocument()
  })

  it('says a detached HEAD is detached', () => {
    renderLine({ ref: '7dd4938', detached: true, worktree: false, defaultBranch: false })
    expect(
      screen.getByLabelText('Main checkout · detached at 7dd4938 · /Users/tomin/Projects/slothworks/orbital'),
    ).toBeInTheDocument()
  })

  it('draws nothing but the path outside a repository', () => {
    render(
      <WhereLine
        path="~/…/notes/weekly"
        fullPath="/Users/tomin/Documents/notes/weekly"
        git={null}
        sessionId="s1"
        panelWidthPx={360}
      />,
    )
    expect(screen.queryByTestId('git-reading')).not.toBeInTheDocument()
    expect(screen.getByLabelText('/Users/tomin/Documents/notes/weekly')).toHaveTextContent(
      '~/…/notes/weekly',
    )
  })
})
