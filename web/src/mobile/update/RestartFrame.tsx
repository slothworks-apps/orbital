/**
 * The restart into a new bundle (canvas `Feature - Phone update`, Restart): a
 * still frame over everything — the Orbital mark and the version on the
 * space colour — for the second the reload takes. The bundle that starts
 * after it shows the same frame until its first screen is drawn, so the two
 * read as one.
 */
export function RestartFrame({ version }: { version: string }) {
  return (
    <div
      role="status"
      aria-label={`Restarting into Orbital ${version}`}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-2.5 bg-space"
    >
      <span
        aria-hidden
        className="relative block h-[22px] w-[22px] rounded-full border-[1.5px] border-accent"
      >
        <span className="absolute -right-px -top-px block h-1.5 w-1.5 rounded-full bg-accent" />
      </span>
      <span className="font-mono fs-10.5 tracking-[0.14em] text-ink-900/65">
        ORBITAL MOBILE {version}
      </span>
    </div>
  )
}
