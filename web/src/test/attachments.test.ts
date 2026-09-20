import { describe, it, expect } from 'vitest'
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MEDIA_TYPES,
  ATTACHMENT_TYPES_LINE,
  MAX_ATTACHMENTS,
  attachmentMeta,
  attachmentName,
  dragCarriesImages,
  filesFrom,
  precheckFile,
  refusalNotice,
  type Refusal,
} from '../lib/attachments'

/** A file of a given type and size without allocating the bytes twice over. */
function fakeFile(name: string, type: string, size: number): File {
  const file = new File([new Uint8Array(1)], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

const MB = 1024 * 1024

describe('client attachment facts (they mirror the server`s)', () => {
  it('names the four media types the store accepts and nothing else', () => {
    expect([...ATTACHMENT_MEDIA_TYPES].sort()).toEqual([
      'image/gif',
      'image/jpeg',
      'image/png',
      'image/webp',
    ])
  })

  it('caps at the server`s own ceiling and count', () => {
    expect(ATTACHMENT_MAX_BYTES).toBe(5 * MB)
    expect(MAX_ATTACHMENTS).toBe(6)
  })

  it('spells the accepted types the way the drop marker does (canvas 9c-1)', () => {
    expect(ATTACHMENT_TYPES_LINE).toBe('png · jpg · gif · webp · up to 5 MB each')
  })
})

describe('precheckFile — refuse before uploading', () => {
  it('passes an image inside the ceiling', () => {
    expect(precheckFile(fakeFile('a.png', 'image/png', 4 * MB))).toBeNull()
  })

  it('refuses a type the store would not take, naming the media type', () => {
    expect(precheckFile(fakeFile('spec.pdf', 'application/pdf', 1000))).toEqual({
      kind: 'not_image',
      name: 'spec.pdf',
      mediaType: 'application/pdf',
    })
  })

  it('refuses a typeless drop (a folder) as not an image', () => {
    expect(precheckFile(fakeFile('src', '', 0))).toMatchObject({ kind: 'not_image' })
  })

  it('refuses an image over the ceiling, carrying the size it measured', () => {
    expect(precheckFile(fakeFile('capture.png', 'image/png', 13 * MB))).toEqual({
      kind: 'too_large',
      name: 'capture.png',
      size: 13 * MB,
    })
  })

  it('checks the type first — a huge PDF is refused for being a PDF', () => {
    expect(precheckFile(fakeFile('big.pdf', 'application/pdf', 99 * MB))).toMatchObject({
      kind: 'not_image',
    })
  })

  // A zero-byte image is deliberately NOT pre-checked: the canvas has no copy
  // for it, and the server's own `400 empty_file` turns into an ordinary chip
  // failure ("didn't upload") that needs none invented.
  it('lets a zero-byte image through to the server`s own 400', () => {
    expect(precheckFile(fakeFile('empty.png', 'image/png', 0))).toBeNull()
  })
})

describe('refusalNotice — one line, never a stack (canvas 9d-C)', () => {
  it('names the measured fact for a single oversize file', () => {
    const refusals: Refusal[] = [{ kind: 'too_large', name: 'capture.png', size: 13_000_000 }]
    expect(refusalNotice(refusals)).toEqual({
      label: 'TOO LARGE TO ATTACH',
      fact: 'capture.png',
      tail: '12.4 MB over the 5 MB ceiling.',
    })
  })

  it('names the media type for a single non-image', () => {
    const refusals: Refusal[] = [
      { kind: 'not_image', name: 'spec.pdf', mediaType: 'application/pdf' },
    ]
    expect(refusalNotice(refusals)).toEqual({
      label: 'IMAGES ONLY',
      fact: 'application/pdf',
      tail: '— mention the path instead.',
    })
  })

  it('collapses several non-images into the canvas`s count line', () => {
    const refusals: Refusal[] = [
      { kind: 'not_image', name: 'a.pdf', mediaType: 'application/pdf' },
      { kind: 'not_image', name: 'b.zip', mediaType: 'application/zip' },
    ]
    expect(refusalNotice(refusals)).toEqual({
      label: 'IMAGES ONLY',
      fact: '2 files',
      tail: "weren't images.",
    })
  })

  it('collapses several oversize files without inventing a combined size', () => {
    const refusals: Refusal[] = [
      { kind: 'too_large', name: 'a.png', size: 9_000_000 },
      { kind: 'too_large', name: 'b.png', size: 8_000_000 },
    ]
    expect(refusalNotice(refusals)).toEqual({
      label: 'TOO LARGE TO ATTACH',
      fact: '2 files',
      tail: 'over the 5 MB ceiling.',
    })
  })

  it('collapses a mixed gesture into one refused count', () => {
    const refusals: Refusal[] = [
      { kind: 'too_large', name: 'a.png', size: 9_000_000 },
      { kind: 'not_image', name: 'b.pdf', mediaType: 'application/pdf' },
    ]
    expect(refusalNotice(refusals)).toEqual({
      label: "CAN'T ATTACH",
      fact: '2 files',
      tail: "weren't images or were too large.",
    })
  })

  it('has nothing to say about an empty gesture', () => {
    expect(refusalNotice([])).toBeNull()
  })
})

describe('attachmentName — never a fake filename (canvas 9c-2)', () => {
  it('calls a paste what it is', () => {
    expect(attachmentName(fakeFile('image.png', 'image/png', 10), 'clipboard')).toBe(
      'Clipboard image'
    )
  })

  it('keeps a dropped file`s own name', () => {
    expect(attachmentName(fakeFile('after-390.png', 'image/png', 10), 'file')).toBe('after-390.png')
  })

  it('falls back to the paste name for a nameless dropped file', () => {
    expect(attachmentName(fakeFile('', 'image/png', 10), 'file')).toBe('Clipboard image')
  })
})

describe('attachmentMeta — the chip`s second line', () => {
  it('reads size while uploading, with the percentage where the size sits', () => {
    expect(attachmentMeta({ state: 'uploading', size: 1_468_006, progress: 62 })).toBe(
      '1.4 MB · uploading 62 %'
    )
  })

  it('omits a percentage it does not have yet', () => {
    expect(attachmentMeta({ state: 'uploading', size: 1_468_006, progress: null })).toBe(
      '1.4 MB · uploading'
    )
  })

  it('reads stored dimensions and size once the bytes land', () => {
    expect(
      attachmentMeta({
        state: 'uploaded',
        size: 290_816,
        progress: null,
        entry: { ref: 'a.png', w: 1512, h: 982, bytes: 290_816 },
      })
    ).toBe('1512×982 · 284 KB')
  })

  it('falls back to the size alone when the server could not sniff dimensions', () => {
    expect(
      attachmentMeta({
        state: 'uploaded',
        size: 290_816,
        progress: null,
        entry: { ref: 'a.gif', w: null, h: null, bytes: 290_816 },
      })
    ).toBe('284 KB')
  })

  it('says what happened on a failure, in the chip`s own voice', () => {
    expect(attachmentMeta({ state: 'failed', size: 1_468_006, progress: null })).toBe(
      "1.4 MB · didn't upload"
    )
  })
})

describe('dragCarriesImages — what arms the drop state (canvas 9c-1)', () => {
  const items = (types: Array<{ kind: string; type: string }>) =>
    ({ items: types, types: ['Files'] }) as unknown as DataTransfer

  it('arms for a drag carrying an image file', () => {
    expect(dragCarriesImages(items([{ kind: 'file', type: 'image/png' }]))).toBe(true)
  })

  it('never arms for a folder — its item type is empty', () => {
    expect(dragCarriesImages(items([{ kind: 'file', type: '' }]))).toBe(false)
  })

  it('never arms for a non-image file', () => {
    expect(dragCarriesImages(items([{ kind: 'file', type: 'application/pdf' }]))).toBe(false)
  })

  it('never arms for a dragged string (a row being reordered)', () => {
    expect(
      dragCarriesImages({ items: [{ kind: 'string', type: 'text/plain' }], types: ['text/plain'] } as unknown as DataTransfer)
    ).toBe(false)
  })

  it('never arms without a DataTransfer at all', () => {
    expect(dragCarriesImages(null)).toBe(false)
  })

  it('falls back to the `types` list when `items` is unavailable', () => {
    expect(
      dragCarriesImages({ types: ['Files', 'image/png'] } as unknown as DataTransfer)
    ).toBe(true)
  })
})

describe('filesFrom — every file a gesture carries', () => {
  const png = fakeFile('a.png', 'image/png', 10)

  it('reads the files list when there is one', () => {
    expect(filesFrom({ files: [png] } as unknown as DataTransfer)).toEqual([png])
  })

  it('falls back to `items` for a clipboard that only fills those', () => {
    const dt = {
      files: [],
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => png }],
    } as unknown as DataTransfer
    expect(filesFrom(dt)).toEqual([png])
  })

  it('drops an item that cannot produce a file, and ignores strings', () => {
    const dt = {
      files: [],
      items: [
        { kind: 'file', type: 'image/png', getAsFile: () => null },
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
      ],
    } as unknown as DataTransfer
    expect(filesFrom(dt)).toEqual([])
  })

  it('has nothing to report without a DataTransfer', () => {
    expect(filesFrom(null)).toEqual([])
  })
})
