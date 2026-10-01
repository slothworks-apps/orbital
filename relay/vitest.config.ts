import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The relay's own metadata log (src/log.ts) on every connect would bury a failure.
    onConsoleLog: (line) => !line.startsWith('relay: '),
  },
});
