import { useEffect } from 'react'
import { unlock } from '../lockFlow'
import { useMobile } from '../state'
import { LitMark, MobileScreen, PrimaryButton } from '../ui'

/**
 * 9t (spec 2026-10-06-pairing-code-and-app-lock-design § 3): the app lock.
 * Nothing from the Mac — the frame, the lit mark, Unlock. It stands over
 * the screen underneath, which stays mounted and comes back on success. It
 * draws first and the system prompt opens over it; a cancel leaves it as it
 * is, and Unlock opens the prompt again. It is also what the app-switcher
 * snapshot shows: the lock covers an open app on its way out.
 */
export function LockScreen() {
  const lock = useMobile((s) => s.lock)
  useEffect(() => {
    // `unlock` moves the lock off `prompt` at once, and asks one prompt at a time.
    if (lock === 'prompt') void unlock()
  }, [lock])

  // Above every sheet (z-20), with the root's safe-area insets of its own since it is fixed.
  return (
    <div className="fixed inset-0 z-40 bg-space pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]">
      {/* canvas 9t: the faint accent light behind the mark. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_300px_260px_at_50%_42%,oklch(85%_.12_205/.06),transparent)]"
      />
      <MobileScreen
        footer={
          <div className="px-4 pb-1.5 pt-2.5">
            <PrimaryButton onClick={() => void unlock()}>Unlock</PrimaryButton>
          </div>
        }
      >
        <div className="grid h-full place-items-center pb-10">
          <h1 className="sr-only">Orbital is locked</h1>
          <LitMark variant="lock" />
        </div>
      </MobileScreen>
    </div>
  )
}
