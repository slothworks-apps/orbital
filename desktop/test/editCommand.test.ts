import { describe, expect, it } from 'vitest';
import { parseEditCommand } from '../src/lib/editCommand';

describe('parseEditCommand', () => {
  it('takes the four edit commands', () => {
    for (const command of ['cut', 'copy', 'paste', 'selectAll']) expect(parseEditCommand(command)).toBe(command);
  });

  it('refuses every other webContents method and anything that is not a name', () => {
    for (const payload of ['reload', 'executeJavaScript', 'openDevTools', '__proto__', 'constructor', 'Copy', '', null, undefined, 1, ['copy'], { command: 'copy' }]) {
      expect(parseEditCommand(payload)).toBeNull();
    }
  });
});
