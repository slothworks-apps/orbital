import { describe, expect, it } from 'vitest';
import {
  VIEW_HEIGHT, VIEW_LIVE_DOMAINS_MAX, VIEW_PAGE_MAX_CHARS, VIEW_DATA_FILE_MAX_BYTES, VIEW_MESSAGE_BLOCK,
  checkCdnHost, clampViewHeight, foldViews, normaliseLiveDomain, parseViewMessage, readCdnHosts, readViewResult,
  showViewRefusal, viewCsp, echoViewResult, utf8Bytes, viewValueBytes, viewErrorText, viewMessageText, viewResultText, type ViewResult,
} from '../src/views.js';

describe('foldViews', () => {
  it('folds a chain of updates into one view, drawn from its newest call', () => {
    const { viewOf, latest, superseded } = foldViews([
      { toolUseId: 'a', input: { title: 'A' } },
      { toolUseId: 'b', input: { replaces: 'a' } },
      { toolUseId: 'c', input: { title: 'C' } },
      // Names a later revision, not the root: still view a.
      { toolUseId: 'd', input: { replaces: 'b' } },
    ]);
    expect([...viewOf]).toEqual([['a', 'a'], ['b', 'a'], ['c', 'c'], ['d', 'a']]);
    expect([...latest]).toEqual([['a', 'd'], ['c', 'c']]);
    expect([...superseded].sort()).toEqual(['a', 'b']);
  });

  it('takes a replaces it has not seen as the view id it names', () => {
    const { viewOf, latest, superseded } = foldViews([
      { toolUseId: 'x', input: { replaces: 'earlier' } },
      { toolUseId: 'y', input: { replaces: 'earlier' } },
    ]);
    expect(viewOf.get('x')).toBe('earlier');
    expect(latest.get('earlier')).toBe('y');
    expect([...superseded]).toEqual(['x']);
  });

  it('leaves out a refused call, which neither shows nor supersedes a view', () => {
    const { viewOf, latest, superseded } = foldViews([
      { toolUseId: 'a', input: {} },
      { toolUseId: 'b', input: { replaces: 'a' }, isError: true },
      { toolUseId: 'c', input: { replaces: 'b' } },
    ]);
    expect(viewOf.has('b')).toBe(false);
    expect(latest.get('a')).toBe('a');
    expect(superseded.size).toBe(0);
    // A replaces naming the refused call is not resolved through it.
    expect(viewOf.get('c')).toBe('b');
  });

  it('ignores a blank or non-string replaces and a missing input', () => {
    const { viewOf } = foldViews([
      { toolUseId: 'a', input: { replaces: '  ' } },
      { toolUseId: 'b', input: { replaces: 3 } },
      { toolUseId: 'c', input: null },
    ]);
    expect([...viewOf.values()]).toEqual(['a', 'b', 'c']);
  });
});

describe('view messages', () => {
  const tricky = ['Release latency', 'p95 (ms) by month', 'a (b) (c)', 'ends in ):', 'with `code` and ```fences```', '  spaced\nout  '];

  it('reads back what it wrote, whatever the title carries', () => {
    for (const title of tricky) {
      const value = { months: ['Jan', 'Mar'], note: 'has ```` four' };
      const read = parseViewMessage(viewMessageText({ viewId: 'toolu_01AB', title, value }));
      expect(read, title).toMatchObject({ viewId: 'toolu_01AB', title: title.replace(/\s+/g, ' ').trim(), kind: 'value', text: '' });
      expect(JSON.parse(read!.body)).toEqual(value);
    }
  });

  it('reads back an error', () => {
    const error = 'TypeError: x is undefined\n    at render (view.js:41)';
    expect(parseViewMessage(viewErrorText({ viewId: 'toolu_1', title: 'Chart (v2)', error }))).toEqual({
      viewId: 'toolu_1', title: 'Chart (v2)', kind: 'error', body: error, text: '',
    });
  });

  it('fences the body with more backticks than any run inside it', () => {
    const text = viewErrorText({ viewId: 'v', title: 'T', error: 'a ````` b' });
    expect(text).toContain('\n``````\n');
    expect(parseViewMessage(text)?.body).toBe('a ````` b');
    expect(viewErrorText({ viewId: 'v', title: 'T', error: 'plain' })).toContain('\n```\nplain\n```');
  });

  it('reads an empty body and what follows the block', () => {
    const text = `${viewErrorText({ viewId: 'v', title: 'T', error: '' })}\n\nand then this`;
    expect(parseViewMessage(text)).toMatchObject({ body: '', text: 'and then this' });
  });

  it('is null for a message that does not open with the block', () => {
    for (const text of [null, '', 'Sent from the view T (v):', 'hello', 'Sent from the view T (v):\n\n```\nunclosed', 'x\nSent from the view T (v):\n\n```\n1\n```']) {
      expect(parseViewMessage(text), String(text)).toBeNull();
    }
  });

  it('VIEW_MESSAGE_BLOCK takes off exactly the block', () => {
    for (const title of tricky) {
      const value = viewMessageText({ viewId: 'v', title, value: [1, '```'] });
      expect(`${value}\n\nrest`.replace(VIEW_MESSAGE_BLOCK, '')).toBe('\nrest');
      expect(viewErrorText({ viewId: 'v', title, error: '' }).replace(VIEW_MESSAGE_BLOCK, '')).toBe('');
    }
  });
});

describe('view results', () => {
  it('reads back every outcome', () => {
    const results: ViewResult[] = [
      { viewId: 'toolu_1', outcome: 'shown' },
      { viewId: 'toolu_1', outcome: 'sent', value: { picked: [0, 2], note: 'with ``` inside' } },
      { viewId: 'toolu_1', outcome: 'sent', value: null },
      { viewId: 'toolu_1', outcome: 'answered', text: 'Just Jan and Mar.\n\nThanks' },
      { viewId: 'toolu_1', outcome: 'cancelled', reason: 'The turn was stopped.' },
      { viewId: 'toolu_1', outcome: 'cancelled', reason: '' },
    ];
    for (const result of results) expect(readViewResult(viewResultText(result))).toEqual(result);
  });

  it('is null for other text', () => {
    for (const text of ['', 'Written: 1 of 2 done.', 'View x: something else.', 'View x: the user sent this from the view.\n\nnot json']) {
      expect(readViewResult(text), text).toBeNull();
    }
  });
});

describe('normaliseLiveDomain', () => {
  it('takes an https host, in lower case and without its scheme', () => {
    expect(normaliseLiveDomain('api.github.com')).toBe('api.github.com');
    expect(normaliseLiveDomain(' HTTPS://API.GitHub.com/ ')).toBe('api.github.com');
    expect(normaliseLiveDomain('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
  });

  it('refuses what is not a public https host', () => {
    for (const raw of [
      'http://api.github.com', 'ftp://x.com', 'api.github.com:443', 'https://api.github.com/repos', '*.github.com',
      '127.0.0.1', '[::1]', 'localhost', 'printer.local', 'db.internal', 'github', '', 'a..com', '-a.com',
      'user@x.com', 'x.com; script-src *', 'x.com?q',
    ]) {
      expect(normaliseLiveDomain(raw), raw).toBeNull();
    }
  });
});

describe('checkCdnHost', () => {
  it('takes a host, in lower case', () => {
    expect(checkCdnHost(' GA.jspm.io ', [])).toEqual({ host: 'ga.jspm.io' });
  });

  it('says what to type instead of a URL', () => {
    expect(checkCdnHost('https://ga.jspm.io/react@18', [])).toEqual({ error: 'bad', suggestion: 'ga.jspm.io' });
    expect(checkCdnHost('ga.jspm.io:443', [])).toEqual({ error: 'bad', suggestion: 'ga.jspm.io' });
    expect(checkCdnHost('es m.sh', [])).toEqual({ error: 'bad' });
    expect(checkCdnHost('http://localhost:3000', [])).toEqual({ error: 'bad' });
  });

  it('refuses a host already listed, built in or added', () => {
    expect(checkCdnHost('unpkg.com', [])).toEqual({ error: 'dup' });
    expect(checkCdnHost('GA.JSPM.IO', [{ host: 'ga.jspm.io', addedAt: 1 }])).toEqual({ error: 'dup' });
    expect(checkCdnHost('https://unpkg.com/x', [])).toEqual({ error: 'bad' });
  });
});

describe('readCdnHosts', () => {
  it('keeps only valid entries, each once, none built in', () => {
    const stored = JSON.stringify([
      { host: 'skypack.dev', addedAt: 1 }, { host: 'SKYPACK.dev', addedAt: 2 }, { host: 'esm.sh', addedAt: 3 },
      { host: 'bad host', addedAt: 4 }, { host: 'x.com' }, 'y.com', null, { host: 'ga.jspm.io', addedAt: 5 },
    ]);
    expect(readCdnHosts(stored)).toEqual([{ host: 'skypack.dev', addedAt: 1 }, { host: 'ga.jspm.io', addedAt: 5 }]);
    for (const bad of [undefined, '', 'not json', '{}']) expect(readCdnHosts(bad)).toEqual([]);
  });
});

describe('echoViewResult', () => {
  it('keeps a short result as it is', () => {
    const sent: ViewResult = { viewId: 'v', outcome: 'sent', value: { a: [1, 2] } };
    expect(echoViewResult(sent, 100)).toEqual(sent);
    expect(echoViewResult({ viewId: 'v', outcome: 'shown' }, 1)).toEqual({ viewId: 'v', outcome: 'shown' });
  });

  it('cuts words and a sent value to the bound in UTF-8 bytes, without splitting a character', () => {
    const answered = echoViewResult({ viewId: 'v', outcome: 'answered', text: '😀'.repeat(100) }, 50) as { text: string };
    expect(utf8Bytes(answered.text)).toBeLessThanOrEqual(50);
    expect(answered.text).toMatch(/^(?:😀)+…$/u);
    const sent = echoViewResult({ viewId: 'v', outcome: 'sent', value: { q: '"\\'.repeat(500) } }, 64) as { value: unknown };
    expect(typeof sent.value).toBe('string');
    expect(viewValueBytes(sent.value)).toBeLessThanOrEqual(64);
  });

  it('measures a value as it is sent', () => {
    expect(viewValueBytes('é')).toBe(4);
    expect(viewValueBytes(undefined)).toBe(4);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(viewValueBytes(loop)).toBeNull();
  });
});

describe('viewCsp', () => {
  it('lets nothing fetch without approved domains', () => {
    const csp = viewCsp({ cdnHosts: [], connect: [] });
    expect(csp).toContain(`connect-src 'none'`);
    expect(csp).toContain(`script-src 'unsafe-inline' 'unsafe-eval' data: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://esm.sh;`);
    expect(csp.startsWith(`default-src 'none'; `)).toBe(true);
  });

  it('drops a host that tries to add a directive', () => {
    const csp = viewCsp({
      cdnHosts: ['ga.jspm.io', "evil.com; script-src *", 'x.com https://*'],
      connect: ['api.github.com', "a.com; connect-src *", 'http://plain.com'],
    });
    expect(csp).toContain('https://ga.jspm.io');
    expect(csp).toContain('connect-src https://api.github.com;');
    expect(csp).not.toContain('evil');
    expect(csp).not.toContain('*');
    expect(csp).not.toContain('plain.com');
    expect(csp.split(';').map((d) => d.trim().split(' ')[0])).toEqual([
      'default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'media-src', 'connect-src', 'form-action', 'base-uri',
    ]);
  });
});

describe('showViewRefusal', () => {
  const ok = { title: 'Chart', html: '<div></div>' };

  it('passes a plain call', () => {
    expect(showViewRefusal(ok)).toBeNull();
    expect(showViewRefusal({ ...ok, height: 9000, liveDomains: ['api.github.com'], data: [1, 2] })).toBeNull();
  });

  it('refuses a page and inline data over the cap, pointing at dataFile', () => {
    const half = 'x'.repeat(VIEW_PAGE_MAX_CHARS / 2);
    expect(showViewRefusal({ ...ok, html: half, data: half })).toContain('dataFile');
    expect(showViewRefusal({ ...ok, html: 'x'.repeat(VIEW_PAGE_MAX_CHARS + 1) })).toContain('dataFile');
  });

  it('refuses a data file that is too large, unreadable, of another kind, or beside data', () => {
    expect(showViewRefusal({ ...ok, dataFile: '/t/a.csv' }, { dataFileBytes: VIEW_DATA_FILE_MAX_BYTES + 1 })).toContain('bytes');
    expect(showViewRefusal({ ...ok, dataFile: '/t/a.csv' }, { dataFileBytes: VIEW_DATA_FILE_MAX_BYTES })).toBeNull();
    expect(showViewRefusal({ ...ok, dataFile: '/t/a.json' }, { dataFileBytes: null })).toContain('cannot be read');
    expect(showViewRefusal({ ...ok, dataFile: '/t/a.xlsx' })).toContain('.json or .csv');
    expect(showViewRefusal({ ...ok, dataFile: '/t/a.json', data: {} })).toContain('not both');
  });

  it('refuses a blank title or page, a height that is no number, and bad or too many domains', () => {
    expect(showViewRefusal({ ...ok, title: ' ' })).toContain('title');
    expect(showViewRefusal({ ...ok, html: '' })).toContain('component');
    expect(showViewRefusal({ title: 'Chart', component: 'export default () => null' })).toBeNull();
    expect(showViewRefusal({ ...ok, component: 'export default () => null' })).toContain('not both');
    expect(showViewRefusal({ ...ok, height: Number.NaN })).toContain('height');
    expect(showViewRefusal({ ...ok, liveDomains: ['http://x.com', 'api.github.com'] })).toContain('"http://x.com"');
    const many = Array.from({ length: VIEW_LIVE_DOMAINS_MAX + 1 }, (_, i) => `d${i}.com`);
    expect(showViewRefusal({ ...ok, liveDomains: many })).toContain(`at most ${VIEW_LIVE_DOMAINS_MAX}`);
  });
});

describe('clampViewHeight', () => {
  it('clamps, rounds and defaults', () => {
    expect(clampViewHeight(undefined)).toBe(VIEW_HEIGHT.default);
    expect(clampViewHeight(Number.NaN)).toBe(VIEW_HEIGHT.default);
    expect(clampViewHeight(VIEW_HEIGHT.min - 1)).toBe(VIEW_HEIGHT.min);
    expect(clampViewHeight(VIEW_HEIGHT.max - 0.4)).toBe(VIEW_HEIGHT.max);
    expect(clampViewHeight(VIEW_HEIGHT.max, true)).toBe(VIEW_HEIGHT.phoneMax);
  });
});
