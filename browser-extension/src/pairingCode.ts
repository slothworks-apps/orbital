/**
 * The pairing code as the popup takes it: six characters typed or pasted
 * into the boxes, in any case, with whatever the clipboard brought along.
 */

/**
 * What a code is made of: the server's alphabet, without 0/O and 1/I, which
 * read alike. Mirrors `PAIRING_CODE_ALPHABET` in
 * `server/src/browser/pairings.ts`.
 */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export const PAIRING_CODE_LENGTH = 6

/**
 * The characters of `input` that can be part of a code, upper-cased, at most
 * `PAIRING_CODE_LENGTH` of them. Spaces, dashes and anything else are dropped,
 * so "k7q-4md" and " K7Q 4MD\n" both give "K7Q4MD".
 */
export function normaliseCode(input: string): string {
  let code = ''
  for (const ch of input.toUpperCase()) {
    if (!PAIRING_CODE_ALPHABET.includes(ch)) continue
    code += ch
    if (code.length === PAIRING_CODE_LENGTH) break
  }
  return code
}

export function isCompleteCode(code: string): boolean {
  return normaliseCode(code) === code && code.length === PAIRING_CODE_LENGTH
}
