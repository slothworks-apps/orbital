import { describe, expect, it } from 'vitest'
import { clampTextScale, textScales } from '../lib/textScale'

describe('textScales', () => {
  it('is today’s size for a Mac that never set it', () => {
    expect(textScales({})).toEqual({ app: 1, transcript: 1 })
  })

  it('gives the transcript the app’s step while it follows', () => {
    expect(textScales({ text_scale: '1.25', transcript_text_scale: 'app' })).toEqual({ app: 1.25, transcript: 1.25 })
  })

  it('gives the transcript its own step instead of multiplying', () => {
    expect(textScales({ text_scale: '1.25', transcript_text_scale: '1.5' })).toEqual({ app: 1.25, transcript: 1.5 })
  })

  it('never makes the transcript smaller than the app', () => {
    expect(textScales({ text_scale: '1.5', transcript_text_scale: '1.125' })).toEqual({ app: 1.5, transcript: 1.5 })
  })

  it('reads a value that is not a step as the default', () => {
    expect(textScales({ text_scale: '3', transcript_text_scale: '0.5' })).toEqual({ app: 1, transcript: 1 })
  })
})

describe('clampTextScale', () => {
  it('holds a measured size to the Mac’s range', () => {
    expect(clampTextScale(0.82)).toBe(1)
    expect(clampTextScale(1.18)).toBe(1.18)
    expect(clampTextScale(3.1)).toBe(1.5)
    expect(clampTextScale(Number.NaN)).toBe(1)
  })
})
