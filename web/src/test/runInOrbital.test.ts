import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import { ORBITAL_COMMANDS, runInOrbital } from '../lib/runInOrbital'
import { useOrbital } from '../store/store'

// Spec 2026-10-20-report-to-github-design § Telling people about gh: Run in
// Orbital starts an ordinary session in the home directory that runs the
// command, with the user's approval like any other.

describe('runInOrbital', () => {
  const launchSession = vi.fn(async () => 'session-1')

  beforeEach(() => {
    launchSession.mockClear()
    vi.mocked(api.renameSession).mockReset()
    vi.mocked(api.renameSession).mockResolvedValue({ ok: true })
    useOrbital.setState({ launchSession })
  })

  it.each([
    ['install-gh', 'brew install gh', 'Install gh'],
    ['login-gh', 'gh auth login --web', 'Log in to gh'],
  ] as const)('%s runs `%s` in ~ and names the session', async (which, command, title) => {
    const started = await runInOrbital(which)

    expect(launchSession).toHaveBeenCalledTimes(1)
    const [body] = launchSession.mock.calls[0] as unknown as [{ cwd: string; prompt: string; permissionMode: string }]
    expect(body.cwd).toBe('~')
    expect(body.prompt).toContain(`\`${command}\``)
    // Not a mode that runs Bash unasked: the user approves the command in the session.
    expect(body.permissionMode).toBe('acceptEdits')
    expect(api.renameSession).toHaveBeenCalledWith('session-1', title)
    expect(started).toEqual({ id: 'session-1', title })
    expect(ORBITAL_COMMANDS[which].command).toBe(command)
  })

  it('the login runs in the background, so the one-time code is shown while gh waits', () => {
    expect(ORBITAL_COMMANDS['login-gh'].prompt).toMatch(/in the background/)
  })

  it('a failed rename still answers with the started session', async () => {
    vi.mocked(api.renameSession).mockRejectedValue(new Error('404'))
    await expect(runInOrbital('install-gh')).resolves.toEqual({ id: 'session-1', title: 'Install gh' })
  })

  it('a failed launch is the caller’s to report', async () => {
    launchSession.mockRejectedValueOnce(new Error('spawn failed'))
    await expect(runInOrbital('install-gh')).rejects.toThrow('spawn failed')
    expect(api.renameSession).not.toHaveBeenCalled()
  })
})
