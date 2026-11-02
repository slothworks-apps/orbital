import { markedPieces, type Mark } from '../lib/directorySearch'

/**
 * Text with the stretches a search matched filled (canvas `Feature - Directory
 * suggestions` 1c): the chip fill, and with `bright` the name's ink too, for
 * the dimmer path line.
 */
export function Marked({ text, marks, bright = false }: { text: string; marks: readonly Mark[]; bright?: boolean }) {
  return markedPieces(text, marks).map((piece, i) =>
    piece.marked ? (
      <span key={i} className={['rounded-[2px] bg-line/24', bright ? 'text-ink-100' : ''].join(' ')}>
        {piece.text}
      </span>
    ) : (
      piece.text
    ),
  )
}
