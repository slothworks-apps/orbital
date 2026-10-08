import { normalizePairingCode } from '@orbital/shared/remote/keys'

/** How many characters a pairing code has: what the phone shows (canvas 9e) and the Mac asks for (9o). */
export const PAIRING_CODE_LENGTH = 6

/**
 * What the field keeps of whatever was typed or pasted: the code's own
 * spelling (`normalizePairingCode`), letters and digits only, cut to length.
 * The server compares; this only keeps the boxes in the alphabet they show.
 */
export function pairingCodeInput(raw: string): string {
  return normalizePairingCode(raw).replace(/[^0-9A-Z]/g, '').slice(0, PAIRING_CODE_LENGTH)
}

type BoxState = 'filled' | 'next' | 'empty'

// Canvas 9o, the code boxes: 44×60, radius 10, mono 30px; the border is
// .24 on a typed box, the accent at .6 on the next one, .14 on the rest.
const BOX_BORDER: Record<BoxState, string> = {
  filled: 'border-[rgba(150,205,255,.24)]',
  next: 'border-accent/60',
  empty: 'border-[rgba(150,205,255,.14)]',
}

function CodeBox({ char, state }: { char: string; state: BoxState }) {
  return (
    <span
      data-state={state}
      className={`grid h-[60px] w-11 place-items-center rounded-[10px] border bg-[rgba(4,8,16,.6)] font-mono text-[30px] text-text-bright ${BOX_BORDER[state]}`}
    >
      {char}
    </span>
  )
}

export interface PairingCodeInputProps {
  value: string
  onChange: (value: string) => void
  /** Enter with all six in (canvas 9o: Enter accepts). */
  onSubmit?: () => void
  disabled?: boolean
  autoFocus?: boolean
}

/**
 * The Mac's half of pairing (canvas 9o): six boxes, 3 + 3, the shape of the
 * phone's 9e step 2. One real text field lies invisible over the boxes, so
 * typing, Backspace and paste behave as in any field; the boxes only draw
 * its value. Typing fills left to right and the next box carries the accent.
 */
export function PairingCodeInput({ value, onChange, onSubmit, disabled, autoFocus }: PairingCodeInputProps) {
  const chars = value.split('')
  const box = (i: number) => (
    <CodeBox
      key={i}
      char={chars[i] ?? ''}
      state={i < chars.length ? 'filled' : i === chars.length ? 'next' : 'empty'}
    />
  )
  return (
    <label className="relative flex cursor-text items-center gap-2">
      {[0, 1, 2].map(box)}
      <span aria-hidden className="block h-[2px] w-2.5 bg-[rgba(160,190,225,.4)]" />
      {[3, 4, 5].map(box)}
      <input
        type="text"
        aria-label="Pairing code"
        value={value}
        onChange={(e) => onChange(pairingCodeInput(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.length === PAIRING_CODE_LENGTH) {
            e.preventDefault()
            onSubmit?.()
          }
        }}
        disabled={disabled}
        // A field the dialog opens on; the user's next keystroke is the code.
        autoFocus={autoFocus}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        className="absolute inset-0 m-0 h-full w-full cursor-text border-0 p-0 text-[16px] opacity-0"
      />
    </label>
  )
}
