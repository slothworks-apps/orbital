import { describe, expect, it } from 'vitest';
import { printable } from '../src/cli/io.js';

/** What every line the CLI prints goes through: names and codes come from other devices. */
describe('printable', () => {
  it('takes out escape sequences, so a name cannot move the cursor, recolour or retitle the terminal', () => {
    expect(printable('nuc\u001b[2J\u001b[31m')).toBe('nuc[2J[31m');
    expect(printable('a\u001b]0;owned\u0007b')).toBe('a]0;ownedb');
    expect(printable('a\u009b31mb')).toBe('a31mb');
  });

  it('takes out a newline, a carriage return, a tab, NUL and DEL, so a name cannot forge a line', () => {
    expect(printable('Pixel\r\nOrbital is not running.\t\u0000\u007f')).toBe('PixelOrbital is not running.');
  });

  it('takes out bidi overrides and isolates, LRM/RLM and the Unicode line separators', () => {
    expect(printable('nuc\u202eexe.txt\u202c')).toBe('nucexe.txt');
    expect(printable('a\u2066b\u2069c\u200e\u200fd\u2028e\u2029f\u202ag\u202bh\u202di\u2067\u2068')).toBe('abcdefghi');
  });

  it('keeps every printable character, accents, arrows and emoji included', () => {
    const s = 'Tomášův Mac · update didn’t finish → 0.36.0 🚀';
    expect(printable(s)).toBe(s);
  });
});
