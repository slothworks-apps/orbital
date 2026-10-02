import { describe, it, expect } from 'vitest'
import { extensionLabel, parseSentFiles, promptWithFiles } from '../lib/attachedFiles'
import { promptWithSelection } from '../lib/ideSelection'

describe('promptWithFiles / parseSentFiles', () => {
  it('appends the list after the typed text and reads it back', () => {
    const sent = promptWithFiles('Sum the Q3 column', ['/Users/me/report.xlsx', '/tmp/a b.csv'])
    expect(sent).toBe('Sum the Q3 column\n\nAttached files:\n- /Users/me/report.xlsx\n- /tmp/a b.csv')
    expect(parseSentFiles(sent)).toEqual({
      text: 'Sum the Q3 column',
      paths: ['/Users/me/report.xlsx', '/tmp/a b.csv'],
    })
  })

  it('sends the list alone when nothing was typed', () => {
    const sent = promptWithFiles('', ['/x/report.xlsx'])
    expect(sent).toBe('Attached files:\n- /x/report.xlsx')
    expect(parseSentFiles(sent)).toEqual({ text: '', paths: ['/x/report.xlsx'] })
  })

  it('leaves a turn with no files as it was', () => {
    expect(promptWithFiles('hi', [])).toBe('hi')
    expect(parseSentFiles('hi')).toBeNull()
  })

  it('survives a trailing newline the transcript may add', () => {
    expect(parseSentFiles('go\n\nAttached files:\n- /a.csv\n')?.paths).toEqual(['/a.csv'])
  })

  it('does not take a lookalike list in the middle of the text', () => {
    expect(parseSentFiles('Attached files:\n- /a.csv\n\nwhat are these?')).toBeNull()
  })

  it('does not take a list of relative paths, which the composer never writes', () => {
    expect(parseSentFiles('note\n\nAttached files:\n- a.csv')).toBeNull()
  })

  it('sits after an IDE selection block, which still parses in front of it', () => {
    const typed = promptWithFiles('explain', ['/x/data.csv'])
    const sent = promptWithSelection(typed, '/repo', {
      filePath: '/repo/src/a.ts', lineStart: 1, lineCount: 2, text: 'const a = 1\nconst b = 2',
    })
    expect(parseSentFiles(sent)?.paths).toEqual(['/x/data.csv'])
  })
})

describe('extensionLabel', () => {
  it('reads the extension, capped, in capitals', () => {
    expect(extensionLabel('report.xlsx')).toBe('XLSX')
    expect(extensionLabel('archive.tar.gz')).toBe('GZ')
    expect(extensionLabel('data.parquet')).toBe('PARQ')
  })

  it('has none for a bare name or a dotfile', () => {
    expect(extensionLabel('Makefile')).toBe('')
    expect(extensionLabel('.env')).toBe('')
  })
})
