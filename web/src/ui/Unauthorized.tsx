import { useEffect } from 'react'
import { Logo } from './Logo'

/** The tab title while signed out, so a pile of tabs shows which one is locked (canvas `Feature - Signed out` 42c). */
const SIGNED_OUT_TITLE = 'Orbital · not signed in'

/**
 * What the page shows when the server refuses it for lacking the API token
 * (spec 2026-10-03-api-token-and-named-files-design § "The client without a
 * token"). The desktop never lands here — it sets the cookie before any window
 * loads — so this is a browser tab opened without the server's link.
 *
 * Canvas `Feature - Signed out` 42a. Neutral ink only: an expected state, not
 * a failure. The terminal line is built from the page's own origin so the user
 * knows which line to look for; the token itself is never on the page.
 */
export function Unauthorized() {
  useEffect(() => {
    const previous = document.title
    document.title = SIGNED_OUT_TITLE
    return () => {
      document.title = previous
    }
  }, [])

  return (
    <div role="status" className="relative h-screen w-screen overflow-hidden bg-space font-sans text-text-bright">
      <div
        aria-hidden
        className="absolute inset-0 bg-[image:radial-gradient(ellipse_620px_420px_at_30%_36%,rgba(110,80,220,.08),transparent),radial-gradient(ellipse_760px_520px_at_72%_70%,rgba(40,170,220,.05),transparent)]"
      />
      <div className="absolute top-6 left-6 flex items-center gap-2.5 opacity-70">
        <Logo />
        <span className="text-[13px] font-bold tracking-[0.22em]">ORBITAL</span>
      </div>

      <div className="absolute inset-0 grid place-items-center p-6">
        <div className="flex w-[560px] max-w-full flex-col gap-7">
          <div className="flex flex-col gap-2.5">
            <div className="font-mono text-[10.5px] tracking-[0.2em] text-[rgba(160,190,225,.6)]">NOT SIGNED IN</div>
            <h1 className="m-0 text-[24px] leading-[1.3] font-semibold tracking-[-0.01em] text-pretty">
              This tab isn't signed in to the Orbital server.
            </h1>
            <p className="m-0 text-[15px] leading-[1.6] text-pretty text-[rgba(190,212,238,.85)]">
              To sign in, open the link the server printed in its terminal when it started.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <div className="overflow-hidden rounded-[10px] border border-[rgba(150,205,255,.14)] bg-[image:linear-gradient(180deg,rgba(14,20,34,.72),rgba(8,12,22,.78))] px-4 py-3.5 font-mono text-[13px] leading-[1.5] text-ellipsis whitespace-nowrap">
              <span className="text-[rgba(160,190,225,.6)]">orbital: open </span>
              {window.location.origin}/api/auth?token=
              <span className="text-[rgba(160,190,225,.6)]">…</span>
            </div>
            <div className="font-mono text-[11px] text-[rgba(160,190,225,.6)]">
              the line to look for · the token is only in your terminal
            </div>
          </div>

          <div className="h-px bg-[rgba(150,205,255,.08)]" />

          <p className="m-0 text-[13.5px] leading-[1.6] text-pretty text-[rgba(160,190,225,.75)]">
            Link stopped working? The server's token was reset. Restart the server and open the new link it prints.
          </p>

          <div className="flex items-center gap-3.5">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="cursor-pointer rounded-full border border-[rgba(150,205,255,.14)] bg-transparent px-3.5 py-1.5 font-mono text-[11px] tracking-[0.12em] text-[rgba(214,230,248,.85)] transition-colors hover:border-[rgba(150,205,255,.3)] hover:bg-[rgba(150,205,255,.08)] hover:text-text-bright"
            >
              RELOAD
            </button>
            <span className="font-mono text-[11px] text-[rgba(160,190,225,.6)]">after opening the link in another tab</span>
          </div>
        </div>
      </div>
    </div>
  )
}
