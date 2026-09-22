/**
 * The empty state (canvas 10c): a fresh install, or any window that measured
 * nothing. Never zeroed charts — a dashboard of dashes reads as broken, and a
 * flat 0 line reads as a real measurement.
 *
 * Two controller rulings are visible here: there is no "import past
 * transcripts" button (nothing to import — the indexer already reads every
 * transcript on this machine), and the footer names no database path.
 */
export function StatsEmpty({ onStartSession }: { onStartSession: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center rounded-[14px] border border-dashed border-[rgba(150,205,255,.12)] px-10 py-16">
      {/* The unmeasured planet: a dim body inside a dashed orbit. */}
      <div aria-hidden className="relative h-[92px] w-[92px]">
        <div className="absolute inset-0 rounded-full border border-[rgba(150,205,255,.18)] bg-[radial-gradient(circle_at_50%_45%,oklch(24%_.03_225),oklch(15%_.02_230)_72%)]" />
        <div
          className="absolute -inset-[22px] rounded-full bg-[repeating-conic-gradient(rgba(150,205,255,.22)_0_1.6deg,transparent_1.6deg_9deg)]"
          style={{
            // The ring is the gradient with its middle masked out; written
            // here rather than as a utility because Tailwind emits no
            // `-webkit-mask`, which Safari still needs.
            mask: 'radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2px))',
            WebkitMask:
              'radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2px))',
          }}
        />
      </div>

      <h2 className="mt-[30px] text-[19px] font-bold tracking-[-0.01em]">Nothing measured yet</h2>
      <p className="mt-2.5 max-w-[520px] text-center text-[13px] leading-[1.6] text-[rgba(160,190,225,.75)] text-pretty">
        Stats are computed from the transcripts on this machine. Finish one session and the tiles,
        the time split and the first findings appear here — usually within a minute of the session
        ending.
      </p>

      <div className="mt-[22px] flex items-center gap-2.5">
        <button
          type="button"
          onClick={onStartSession}
          className="cursor-pointer rounded-[9px] bg-accent px-4 py-[9px] font-mono text-[11.5px] font-bold text-space-deep"
        >
          start a session
        </button>
      </div>

      <div aria-hidden className="mt-[34px] flex gap-2.5 opacity-50">
        {['TOTAL TOKENS', 'COST', 'AGENT BUSY TIME'].map((label) => (
          <div
            key={label}
            className="h-[74px] w-[196px] rounded-xl border border-[rgba(150,205,255,.09)] bg-[rgba(8,12,22,.5)] px-[15px] py-[13px]"
          >
            <div className="font-mono text-[9.5px] tracking-[0.18em] text-[rgba(160,190,225,.4)]">
              {label}
            </div>
            <div className="mt-[9px] font-mono text-[26px] leading-none text-[rgba(160,190,225,.3)]">
              —
            </div>
          </div>
        ))}
      </div>

      <div className="mt-[26px] font-mono text-[10.5px] text-[rgba(160,190,225,.45)]">
        no data leaves this machine
      </div>
    </div>
  )
}
