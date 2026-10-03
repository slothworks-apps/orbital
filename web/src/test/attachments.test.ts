import { describe, it, expect } from 'vitest'
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MEDIA_TYPES,
  ATTACHMENT_TYPES_LINE,
  MAX_ATTACHMENTS,
  attachmentMeta,
  attachmentName,
  dragCarriesFiles,
  folderNames,
  isInlineImage,
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
    expect(ATTACHMENT_TYPES_LINE).toBe('any file · images up to 5 MB go inline')
  })
})

describe('isInlineImage — what rides as an image block', () => {
  it('takes an image the store accepts within the ceiling', () => {
    expect(isInlineImage(fakeFile('a.png', 'image/png', 4 * MB))).toBe(true)
  })

  it('sends an image over the ceiling by path instead', () => {
    expect(isInlineImage(fakeFile('capture.png', 'image/png', 13 * MB))).toBe(false)
  })

  it('sends anything else by path', () => {
    expect(isInlineImage(fakeFile('report.xlsx', 'application/vnd.ms-excel', 1000))).toBe(false)
    expect(isInlineImage(fakeFile('shot.svg', 'image/svg+xml', 1000))).toBe(false)
  })
})

describe('precheckFile — refuse before uploading', () => {
  const browser = { hasPath: false, folder: false }

  it('passes an image inside the ceiling and an ordinary file', () => {
    expect(precheckFile(fakeFile('a.png', 'image/png', 4 * MB), browser)).toBeNull()
    expect(precheckFile(fakeFile('report.xlsx', 'application/vnd.ms-excel', 4 * MB), browser)).toBeNull()
  })

  it('refuses an upload past the file ceiling, carrying the size it measured', () => {
    expect(precheckFile(fakeFile('dump.bin', '', 130 * MB), browser)).toEqual({
      kind: 'too_large',
      name: 'dump.bin',
      size: 130 * MB,
    })
  })

  it('refuses a folder it would have to upload', () => {
    expect(precheckFile(fakeFile('src', '', 0), { hasPath: false, folder: true })).toEqual({
      kind: 'folder',
      name: 'src',
    })
  })

  it('takes anything with a desktop path, at any size, folders included', () => {
    expect(precheckFile(fakeFile('dump.bin', '', 130 * MB), { hasPath: true, folder: false })).toBeNull()
    expect(precheckFile(fakeFile('src', '', 0), { hasPath: true, folder: true })).toBeNull()
  })
})

describe('refusalNotice — one line, never a stack (canvas 9d-C)', () => {
  it('names the measured fact for a single oversize file', () => {
    const refusals: Refusal[] = [{ kind: 'too_large', name: 'dump.bin', size: 130 * MB }]
    expect(refusalNotice(refusals)).toEqual({
      label: 'TOO LARGE TO ATTACH',
      fact: 'dump.bin',
      tail: '130 MB over the 100 MB ceiling.',
    })
  })

  it('names a single folder', () => {
    expect(refusalNotice([{ kind: 'folder', name: 'src' }])).toEqual({
      label: "CAN'T ATTACH",
      fact: 'src',
      tail: '— a folder needs the desktop app.',
    })
  })

  it('collapses several oversize files without inventing a combined size', () => {
    const refusals: Refusal[] = [
      { kind: 'too_large', name: 'a.bin', size: 190 * MB },
      { kind: 'too_large', name: 'b.bin', size: 180 * MB },
    ]
    expect(refusalNotice(refusals)).toEqual({
      label: 'TOO LARGE TO ATTACH',
      fact: '2 files',
      tail: 'over the 100 MB ceiling.',
    })
  })

  it('collapses a mixed gesture into one refused count', () => {
    const refusals: Refusal[] = [
      { kind: 'too_large', name: 'a.bin', size: 190 * MB },
      { kind: 'folder', name: 'src' },
    ]
    expect(refusalNotice(refusals)).toEqual({
      label: "CAN'T ATTACH",
      fact: '2 files',
      tail: 'were folders or too large.',
    })
  })

  it('says nothing for nothing', () => {
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

  it('names the photo`s size before the phone downscaled it, and the edge it was sent at', () => {
    expect(
      attachmentMeta({
        state: 'uploaded',
        size: 290_816,
        progress: null,
        entry: { ref: 'a.jpg', w: 1568, h: 1176, bytes: 290_816 },
        original: { w: 4032, h: 3024 },
      })
    ).toBe('4032×3024 → sent at 1568 px')
  })

  it('still reads as uploading while a photo with an original size is on its way', () => {
    expect(
      attachmentMeta({ state: 'uploading', size: 290_816, progress: null, original: { w: 4032, h: 3024 } })
    ).toBe('284 KB · uploading')
  })

  it('reads an uploaded image without an original size as before', () => {
    expect(
      attachmentMeta({
        state: 'uploaded',
        size: 290_816,
        progress: null,
        entry: { ref: 'a.jpg', w: 1568, h: 1176, bytes: 290_816 },
      })
    ).toBe('1568×1176 · 284 KB')
  })

  it('says what happened on a failure, in the chip`s own voice', () => {
    expect(attachmentMeta({ state: 'failed', size: 1_468_006, progress: null })).toBe(
      "1.4 MB · didn't upload"
    )
  })
})

describe('dragCarriesFiles — what arms the drop state (canvas 9c-1)', () => {
  const items = (types: Array<{ kind: string; type: string }>) =>
    ({ items: types, types: ['Files'] }) as unknown as DataTransfer

  it('arms for a drag carrying any file, a folder included', () => {
    expect(dragCarriesFiles(items([{ kind: 'file', type: 'image/png' }]))).toBe(true)
    expect(dragCarriesFiles(items([{ kind: 'file', type: 'application/pdf' }]))).toBe(true)
    expect(dragCarriesFiles(items([{ kind: 'file', type: '' }]))).toBe(true)
  })

  it('never arms for a dragged string (a row being reordered)', () => {
    expect(
      dragCarriesFiles({ items: [{ kind: 'string', type: 'text/plain' }], types: ['text/plain'] } as unknown as DataTransfer)
    ).toBe(false)
  })

  it('never arms without a DataTransfer at all', () => {
    expect(dragCarriesFiles(null)).toBe(false)
  })

  it('falls back to the `types` list when `items` is unavailable', () => {
    expect(dragCarriesFiles({ types: ['Files'] } as unknown as DataTransfer)).toBe(true)
    expect(dragCarriesFiles({ types: ['text/plain'] } as unknown as DataTransfer)).toBe(false)
  })
})

describe('folderNames — which dropped entries are folders', () => {
  it('names the directory entries and nothing else', () => {
    const entry = (name: string, isDirectory: boolean) => ({ name, isDirectory })
    const dt = {
      items: [
        { kind: 'file', webkitGetAsEntry: () => entry('src', true) },
        { kind: 'file', webkitGetAsEntry: () => entry('a.csv', false) },
        { kind: 'string' },
      ],
    } as unknown as DataTransfer
    expect([...folderNames(dt)]).toEqual(['src'])
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
