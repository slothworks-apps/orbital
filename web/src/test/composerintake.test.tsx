import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import { Composer } from '../panels/Composer'
import { useAttachments } from '../panels/useAttachments'
import { useImageDrop } from '../panels/useImageDrop'
import { MAX_ATTACHMENTS } from '../lib/attachments'
import type { AttachmentUpload, ImageRefEntry } from '../lib/types'
import type { SentAttachment } from '../store/store'
import { fieldValue, replaceField } from './composerField'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MB = 1024 * 1024

/** A File of a stated type and size, without allocating the bytes. */
function fakeFile(name: string, type: string, size = 1000): File {
  const file = new File([new Uint8Array(1)], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

const png = (name = 'after-390.png', size = 200_704) => fakeFile(name, 'image/png', size)

function entry(ref: string, bytes = 200_704): ImageRefEntry {
  return { ref, w: 1170, h: 760, bytes }
}

/**
 * jsdom has no DataTransfer — the same shim `tagsrules.test.tsx` uses for its
 * row reorder, widened to carry files and per-file `items` (which is what the
 * drop state reads to tell an image drag from a folder).
 */
function makeDataTransfer(files: File[]) {
  return {
    files,
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    types: files.length > 0 ? ['Files'] : [],
    getData: () => '',
    dropEffect: '',
    effectAllowed: '',
  } as unknown as DataTransfer
}

/** A drag that carries a directory: one item, `kind: 'file'`, no media type. */
const FOLDER_DRAG = {
  files: [],
  items: [{ kind: 'file', type: '', getAsFile: () => null }],
  types: ['Files'],
} as unknown as DataTransfer

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------------------
// Harness — the DetailPanel mount in miniature: the panel is the drop target,
// the well is the marker, and the composer owns the chips.
// ---------------------------------------------------------------------------

let sent: SentAttachment[] | null = null

function Harness({ placeholder = 'Send a message…' }: { placeholder?: string }) {
  const [value, setValue] = useState('')
  const attachments = useAttachments('s1')
  const { armed: dropArmed, ref: dropRef } = useImageDrop((files) =>
    attachments.accept(files, 'file'),
  )

  return (
    <div ref={dropRef} data-testid="panel" data-drop-armed={dropArmed || undefined}>
      <Composer
        sessionKey={{ session: 's1' }}
        value={value}
        onChange={setValue}
        enter="send"
        placement="above"
        variant="panel"
        hint="⏎ send · ⇧⏎ newline · ⌘V paste image"
        placeholder={placeholder}
        aria-label="Prompt"
        attachments={attachments}
        dropArmed={dropArmed}
      />
      <button
        type="button"
        onClick={() => {
          void attachments.takeForSend().then((taken) => {
            sent = taken
          })
        }}
      >
        take
      </button>
      {/* What the panel's Send button reads to decide whether it is live. */}
      <span data-testid="composer-armed">{attachments.armed ? 'yes' : 'no'}</span>
    </div>
  )
}

const field = () => screen.getByRole('textbox', { name: 'Prompt' })
const panel = () => screen.getByTestId('panel')
const chips = () => screen.queryAllByTestId('attachment-chip')
const chip = (index = 0) => chips()[index]
const meta = (index = 0) => chip(index).querySelector('[data-chip-meta]')!.textContent
const name = (index = 0) => chip(index).querySelector('[data-chip-name]')!.textContent
const refusal = () => screen.queryByTestId('composer-refusal')
const marker = () => screen.queryByTestId('drop-marker')

/** ⌘V with an image on the clipboard. */
function paste(files: File[]) {
  fireEvent.paste(field(), { clipboardData: makeDataTransfer(files) })
}

function drop(files: File[]) {
  const dt = makeDataTransfer(files)
  fireEvent.dragEnter(panel(), { dataTransfer: dt })
  fireEvent.dragOver(panel(), { dataTransfer: dt })
  fireEvent.drop(panel(), { dataTransfer: dt })
}

/**
 * This whole file runs on a fake clock — the progress ticker, the ×'s exit fade,
 * the drop grace and the refusal hold are all timers, and asserting on them with
 * real ones would mean sleeping through four seconds per case.
 *
 * Which is also why `waitFor` is local: RTL's polls on the very timers the fake
 * clock replaced, so under it, it never gets a second look. This one advances
 * the clock between attempts.
 */
async function waitFor(check: () => void, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      check()
      return
    } catch {
      // Not yet.
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })
  }
  check()
}

// jsdom implements neither half of the object-URL pair, so both are installed
// for the file and never taken away again: RTL's own cleanup unmounts AFTER this
// file's `afterEach`, and the hook revokes its previews on unmount.
URL.createObjectURL = vi.fn(() => 'blob:preview')
URL.revokeObjectURL = vi.fn()

beforeEach(() => {
  sent = null
  vi.useFakeTimers()
  vi.mocked(api.uploadAttachment).mockReset()
  vi.mocked(api.uploadAttachment).mockResolvedValue({ kind: 'ok', entry: entry('ok.png') })
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Paste (canvas 9c-2)
// ---------------------------------------------------------------------------

describe('Composer intake — paste', () => {
  it('turns a pasted image into one chip, honestly named, and uploads it', async () => {
    render(<Harness />)
    paste([png('image.png')])

    await waitFor(() => expect(chips()).toHaveLength(1))
    expect(name()).toBe('Clipboard image')
    expect(api.uploadAttachment).toHaveBeenCalledWith('s1', expect.any(File), {
      signal: expect.any(AbortSignal),
    })
  })

  it('shows the local preview at once, before any byte has landed', async () => {
    const pending = deferred<AttachmentUpload>()
    vi.mocked(api.uploadAttachment).mockReturnValue(pending.promise)
    render(<Harness />)
    paste([png()])

    await waitFor(() => expect(chips()).toHaveLength(1))
    const thumb = chip().querySelector('[data-chip-thumb]') as HTMLImageElement
    expect(thumb.src).toBe('blob:preview')
    expect(chip()).toHaveAttribute('data-state', 'uploading')

    await act(async () => {
      pending.resolve({ kind: 'ok', entry: entry('a.png', 290_816) })
    })
    expect(chip()).toHaveAttribute('data-state', 'uploaded')
  })

  it('ignores a paste that carries no image at all — that is just text', async () => {
    render(<Harness />)
    paste([])
    await act(async () => {})
    expect(chips()).toHaveLength(0)
    expect(refusal()).toBeNull()
  })

  it('reads the stored dimensions and size into the chip once the bytes land', async () => {
    vi.mocked(api.uploadAttachment).mockResolvedValue({
      kind: 'ok',
      entry: { ref: 'a.png', w: 1512, h: 982, bytes: 290_816 },
    })
    render(<Harness />)
    paste([png()])
    await waitFor(() => expect(meta()).toBe('1512×982 · 284 KB'))
  })
})

// ---------------------------------------------------------------------------
// Uploading + failure (canvas 9d-A / 9d-B)
// ---------------------------------------------------------------------------

describe('Composer intake — the upload', () => {
  it('suppresses the progress rail entirely for an upload under the tick', async () => {
    render(<Harness />)
    paste([png()])
    await waitFor(() => expect(chip()).toHaveAttribute('data-state', 'uploaded'))
    expect(chip().querySelector('[data-chip-rail]')).toBeNull()
    expect(meta()).not.toContain('uploading')
  })

  it('shows the rail and a percentage once the upload outlives the tick', async () => {
    const pending = deferred<AttachmentUpload>()
    vi.mocked(api.uploadAttachment).mockReturnValue(pending.promise)
    render(<Harness />)
    paste([png('big.png', 1_468_006)])
    await waitFor(() => expect(chips()).toHaveLength(1))

    // Before the first tick there is no number to show, so none is shown.
    expect(meta()).toBe('1.4 MB · uploading')
    expect(chip().querySelector('[data-chip-rail]')).toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    expect(chip().querySelector('[data-chip-rail]')).not.toBeNull()
    expect(meta()).toMatch(/^1\.4 MB · uploading \d+ %$/)

    await act(async () => {
      pending.resolve({ kind: 'ok', entry: entry('a.png') })
    })
    expect(chip().querySelector('[data-chip-rail]')).toBeNull()
  })

  it('aborts the upload when × is pressed, and the chip leaves', async () => {
    const pending = deferred<AttachmentUpload>()
    let seen: AbortSignal | undefined
    vi.mocked(api.uploadAttachment).mockImplementation(async (_id, _file, opts) => {
      seen = opts?.signal
      return pending.promise
    })
    render(<Harness />)
    paste([png()])
    await waitFor(() => expect(chips()).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }))
    expect(seen?.aborted).toBe(true)

    // The × fades the chip out before the row reflows (canvas 9e).
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(chips()).toHaveLength(0)
  })

  it('reads a refused upload as a failure the chip can retry', async () => {
    vi.mocked(api.uploadAttachment).mockResolvedValueOnce({ kind: 'empty' })
    render(<Harness />)
    paste([png('before-390.png', 1_468_006)])

    await waitFor(() => expect(chip()).toHaveAttribute('data-state', 'failed'))
    expect(meta()).toBe("1.4 MB · didn't upload")
    expect(screen.getByRole('button', { name: 'retry' })).toBeInTheDocument()
  })

  it('retries in place, keeping the chip where it was', async () => {
    vi.mocked(api.uploadAttachment).mockRejectedValueOnce(new Error('network'))
    render(<Harness />)
    paste([png()])
    await waitFor(() => expect(chip()).toHaveAttribute('data-state', 'failed'))

    vi.mocked(api.uploadAttachment).mockResolvedValueOnce({ kind: 'ok', entry: entry('a.png') })
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    await waitFor(() => expect(chip()).toHaveAttribute('data-state', 'uploaded'))
    expect(chips()).toHaveLength(1)
  })

  it('stops offering retry after two failed retries, leaving the chip removable', async () => {
    vi.mocked(api.uploadAttachment).mockRejectedValue(new Error('network'))
    render(<Harness />)
    paste([png()])
    await waitFor(() => expect(chip()).toHaveAttribute('data-state', 'failed'))

    for (const _ of [1, 2]) {
      fireEvent.click(screen.getByRole('button', { name: 'retry' }))
      await waitFor(() => expect(chip()).toHaveAttribute('data-state', 'failed'))
    }

    expect(screen.queryByRole('button', { name: 'retry' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove attachment' })).toBeInTheDocument()
  })

  it('carries a note line under a failed chip (canvas 9d-B)', async () => {
    vi.mocked(api.uploadAttachment).mockRejectedValue(new Error('network'))
    render(<Harness />)
    paste([png()])
    await waitFor(() => expect(chip()).toHaveAttribute('data-state', 'failed'))
    expect(screen.getByTestId('attachment-note')).toHaveTextContent(/nothing else was lost/i)
  })
})

// ---------------------------------------------------------------------------
// The client pre-check (canvas 9d-C)
// ---------------------------------------------------------------------------

describe('Composer intake — refusals', () => {
  it('creates no chip and replaces the hint line in place, naming the fact', async () => {
    render(<Harness />)
    paste([fakeFile('capture.png', 'image/png', 13 * MB)])
    await act(async () => {})

    expect(chips()).toHaveLength(0)
    expect(api.uploadAttachment).not.toHaveBeenCalled()
    expect(refusal()).toHaveTextContent('TOO LARGE TO ATTACH')
    expect(refusal()).toHaveTextContent('capture.png')
    expect(refusal()).toHaveTextContent('13 MB over the 5 MB ceiling.')
    expect(screen.queryByText('⏎ send · ⇧⏎ newline · ⌘V paste image')).not.toBeInTheDocument()
  })

  it('points a non-image at the mention instead', async () => {
    render(<Harness />)
    paste([fakeFile('spec.pdf', 'application/pdf')])
    await act(async () => {})
    expect(refusal()).toHaveTextContent('IMAGES ONLY')
    expect(refusal()).toHaveTextContent('application/pdf')
    expect(refusal()).toHaveTextContent('— mention the path instead.')
  })

  it('gives the hint line back after the hold', async () => {
    render(<Harness />)
    paste([fakeFile('spec.pdf', 'application/pdf')])
    await act(async () => {})
    expect(refusal()).not.toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(4300)
    })
    expect(refusal()).toBeNull()
    expect(screen.getByText('⏎ send · ⇧⏎ newline · ⌘V paste image')).toBeInTheDocument()
  })

  it('collapses a mixed drop: chips for the images, one line for the rest', async () => {
    render(<Harness />)
    drop([
      png('a.png'),
      png('b.png'),
      png('c.png'),
      fakeFile('one.pdf', 'application/pdf'),
      fakeFile('two.pdf', 'application/pdf'),
    ])
    await waitFor(() => expect(chips()).toHaveLength(3))
    expect(refusal()).toHaveTextContent("2 files")
    expect(refusal()).toHaveTextContent("weren't images.")
  })

  it('rewrites the line on a second refusal rather than stacking', async () => {
    render(<Harness />)
    paste([fakeFile('spec.pdf', 'application/pdf')])
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    paste([fakeFile('capture.png', 'image/png', 13 * MB)])
    await act(async () => {})

    expect(screen.getAllByTestId('composer-refusal')).toHaveLength(1)
    expect(refusal()).toHaveTextContent('TOO LARGE TO ATTACH')

    // The timer restarted with the new line: the first one's 4s is already up.
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(refusal()).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The ceiling (canvas 9c-2 / 9e)
// ---------------------------------------------------------------------------

describe('Composer intake — the ceiling', () => {
  it('takes as many as fit and no more', async () => {
    render(<Harness />)
    drop(Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, i) => png(`p${i}.png`)))
    await waitFor(() => expect(chips()).toHaveLength(MAX_ATTACHMENTS))
  })

  it('lets the last chip hide the placeholder, never the text', async () => {
    render(<Harness />)
    expect(field()).toHaveAttribute('aria-placeholder', 'Send a message…')

    drop(Array.from({ length: MAX_ATTACHMENTS }, (_, i) => png(`p${i}.png`)))
    await waitFor(() => expect(chips()).toHaveLength(MAX_ATTACHMENTS))
    expect(field()).not.toHaveAttribute('aria-placeholder')

    replaceField(field(), 'still typing')
    expect(fieldValue(field())).toBe('still typing')
  })
})

// ---------------------------------------------------------------------------
// Drop (canvas 9c-1)
// ---------------------------------------------------------------------------

describe('Composer intake — the drop state', () => {
  it('arms the whole panel on a drag carrying images, and the well becomes the marker', () => {
    render(<Harness />)
    replaceField(field(), 'kept under the marker')
    fireEvent.dragEnter(panel(), { dataTransfer: makeDataTransfer([png()]) })

    expect(panel()).toHaveAttribute('data-drop-armed', 'true')
    expect(marker()).toHaveTextContent('DROP TO ATTACH')
    expect(marker()).toHaveTextContent('png · jpg · gif · webp · up to 5 MB each')
    // Typed text is kept, hidden under the marker (9c-1).
    expect(fieldValue(field())).toBe('kept under the marker')
  })

  it('never arms for a folder — no flash, no "can`t drop that"', () => {
    render(<Harness />)
    fireEvent.dragEnter(panel(), { dataTransfer: FOLDER_DRAG })
    expect(panel()).not.toHaveAttribute('data-drop-armed')
    expect(marker()).toBeNull()
  })

  it('never arms for a drag with no files at all', () => {
    render(<Harness />)
    fireEvent.dragEnter(panel(), {
      dataTransfer: { items: [{ kind: 'string', type: 'text/plain' }], types: ['text/plain'] },
    })
    expect(panel()).not.toHaveAttribute('data-drop-armed')
  })

  it('holds the state across a child boundary for the leave grace', async () => {
    render(<Harness />)
    const dt = makeDataTransfer([png()])
    fireEvent.dragEnter(panel(), { dataTransfer: dt })
    fireEvent.dragLeave(panel(), { dataTransfer: dt })

    // Still armed inside the grace — crossing a child must not flicker.
    await act(async () => {
      vi.advanceTimersByTime(40)
    })
    expect(panel()).toHaveAttribute('data-drop-armed', 'true')

    fireEvent.dragEnter(panel(), { dataTransfer: dt })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(panel()).toHaveAttribute('data-drop-armed', 'true')
  })

  it('disarms once the drag really has left', async () => {
    render(<Harness />)
    const dt = makeDataTransfer([png()])
    fireEvent.dragEnter(panel(), { dataTransfer: dt })
    fireEvent.dragLeave(panel(), { dataTransfer: dt })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(panel()).not.toHaveAttribute('data-drop-armed')
  })

  it('disarms on the drop itself and takes the files', async () => {
    render(<Harness />)
    drop([png('after-390.png')])
    await waitFor(() => expect(chips()).toHaveLength(1))
    expect(panel()).not.toHaveAttribute('data-drop-armed')
    // A dropped file keeps its own name (9c-2).
    expect(name()).toBe('after-390.png')
  })
})

// ---------------------------------------------------------------------------
// The send hand-off (canvas 9c-3 / 9d-A)
// ---------------------------------------------------------------------------

describe('Composer intake — handing the turn its images', () => {
  it('reports what is armed, and a failed chip alone arms nothing', async () => {
    vi.mocked(api.uploadAttachment).mockRejectedValueOnce(new Error('network'))
    render(<Harness />)
    paste([png()])
    await waitFor(() => expect(chip()).toHaveAttribute('data-state', 'failed'))
    expect(screen.getByTestId('composer-armed')).toHaveTextContent('no')

    vi.mocked(api.uploadAttachment).mockResolvedValueOnce({ kind: 'ok', entry: entry('a.png') })
    paste([png('b.png')])
    await waitFor(() => expect(screen.getByTestId('composer-armed')).toHaveTextContent('yes'))
  })

  it('clears the chips and hands over the entries with their provenance', async () => {
    vi.mocked(api.uploadAttachment).mockResolvedValue({
      kind: 'ok',
      entry: { ref: 'aaa.png', w: 10, h: 10, bytes: 99 },
    })
    render(<Harness />)
    paste([png('image.png')])
    await waitFor(() => expect(chip()).toHaveAttribute('data-state', 'uploaded'))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'take' }))
    })

    expect(chips()).toHaveLength(0)
    expect(sent).toEqual([
      { entry: { ref: 'aaa.png', w: 10, h: 10, bytes: 99 }, name: 'Clipboard image', source: 'clipboard' },
    ])
  })

  it('waits for an upload still in flight, then fires', async () => {
    const pending = deferred<AttachmentUpload>()
    vi.mocked(api.uploadAttachment).mockReturnValue(pending.promise)
    render(<Harness />)
    paste([png()])
    await waitFor(() => expect(chips()).toHaveLength(1))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'take' }))
    })
    // The field cleared, but the turn has not been handed anything yet.
    expect(chips()).toHaveLength(0)
    expect(sent).toBeNull()

    await act(async () => {
      pending.resolve({ kind: 'ok', entry: entry('late.png') })
    })
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent![0].entry.ref).toBe('late.png')
  })

  it('leaves a failed chip behind — it is not in the turn and not lost either', async () => {
    vi.mocked(api.uploadAttachment).mockRejectedValueOnce(new Error('network'))
    render(<Harness />)
    paste([png('broken.png')])
    await waitFor(() => expect(chip()).toHaveAttribute('data-state', 'failed'))

    vi.mocked(api.uploadAttachment).mockResolvedValueOnce({ kind: 'ok', entry: entry('good.png') })
    paste([png('good.png')])
    await waitFor(() => expect(chips()).toHaveLength(2))
    await waitFor(() => expect(chip(1)).toHaveAttribute('data-state', 'uploaded'))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'take' }))
    })

    expect(chips()).toHaveLength(1)
    expect(chip()).toHaveAttribute('data-state', 'failed')
    expect(sent).toEqual([expect.objectContaining({ name: 'Clipboard image' })])
    expect(sent![0].entry.ref).toBe('good.png')
  })
})
