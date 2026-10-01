import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { isAllowed, allowedPath, ALLOWED_ROUTES } from '../src/remote/allowlist.js';

describe('remote allowlist', () => {
  it('allows the session, decision, spawn and catalogue routes', () => {
    for (const [m, p] of [
      ['GET', '/api/sessions'], ['GET', '/api/sessions/abc'], ['GET', '/api/sessions/abc/messages'],
      ['GET', '/api/sessions/abc/messages?limit=30&before=x'],
      ['GET', '/api/sessions/abc/subagents/toolu_1/messages'],
      ['POST', '/api/sessions'], ['POST', '/api/sessions/abc/messages'],
      ['POST', '/api/sessions/abc/decision/d1'], ['POST', '/api/sessions/abc/interrupt'],
      ['POST', '/api/sessions/abc/model'], ['POST', '/api/sessions/abc/permission-mode'],
      ['POST', '/api/sessions/abc/end'], ['POST', '/api/sessions/abc/reopen'], ['POST', '/api/sessions/abc/clear'],
      ['PATCH', '/api/sessions/abc'], ['PUT', '/api/sessions/abc/pinned'], ['PUT', '/api/sessions/abc/tags'],
      ['POST', '/api/sessions/abc/tasks/t1/stop'], ['GET', '/api/sessions/abc/tasks/t1/output'],
      ['GET', '/api/tags'], ['GET', '/api/projects'], ['GET', '/api/models'], ['GET', '/api/commands'],
      ['GET', '/api/sessions/abc/walkthrough'], ['GET', '/api/sessions/abc/walkthrough/summary'],
      ['GET', '/api/health'],
    ]) expect(isAllowed(m, p), `${m} ${p}`).toBe(true);
  });
  it('denies the file system, the editor, settings, errors, rules and dev routes', () => {
    for (const [m, p] of [
      ['GET', '/api/files?path=/etc/passwd'], ['GET', '/api/files/complete'], ['GET', '/api/commands/content'],
      ['GET', '/api/sessions/abc/ide/open-files'], ['POST', '/api/sessions/abc/ide/open-file'],
      ['GET', '/api/settings'], ['PATCH', '/api/settings'], ['PATCH', '/api/settings/'],
      ['GET', '/api/errors'], ['POST', '/api/errors'], ['GET', '/api/tag-rules'], ['POST', '/api/tag-rules/preview'],
      ['POST', '/api/tags'], ['DELETE', '/api/tags/1'], ['POST', '/api/dev/sessions/abc/simulate-compaction'],
      ['POST', '/api/attachments'], ['POST', '/api/sessions/abc/attachments'], ['GET', '/api/images/abc.png'],
      ['POST', '/api/sessions/abc/rewind'], ['POST', '/api/sessions/abc/retitle'],
      ['POST', '/api/sessions/abc/walkthrough/narrate'], ['POST', '/api/models/validate'],
      ['POST', '/api/branch-status/refresh'], ['GET', '/api/sessions/retention-preview'],
      ['GET', '/api/remote'], ['POST', '/api/remote/pair'], ['DELETE', '/api/remote/devices/x'],
      ['GET', '/ws'], ['GET', '/'], ['GET', '/index.html'],
    ]) expect(isAllowed(m, p), `${m} ${p}`).toBe(false);
  });
  it('is strict about shape: method case, traversal, empty segments, encoded slashes', () => {
    expect(isAllowed('get', '/api/sessions')).toBe(false);
    expect(isAllowed('GET', '/api/sessions/../files')).toBe(false);
    expect(isAllowed('GET', '/api/sessions//messages')).toBe(false);
    expect(isAllowed('GET', '/api/sessions/a%2F..%2Fx/messages')).toBe(false);
    // No trailing-slash stripping any more: Fastify does not ignore
    // trailing slashes, so a trailing slash is a different (denied) shape.
    expect(isAllowed('GET', '/api/sessions/abc/')).toBe(false);
    expect(isAllowed('GET', 'api/sessions')).toBe(false);
  });

  describe('pinned against the real router', () => {
    /**
     * A bare Fastify instance with every allowed template registered, plus a
     * sample of the routes the allowlist must deny. The handler echoes back
     * which route matched, so a test can check that the path `allowedPath`
     * approves is routed to the template we meant to allow — not quietly to
     * one of the denied routes sharing the same tree, which is exactly how
     * the canonicalization bug this file guards against was reachable.
     */
    function buildRouterApp() {
      const app = Fastify();
      const routes: ReadonlyArray<readonly [string, string]> = [
        ...ALLOWED_ROUTES,
        ['GET', '/api/files'],
        ['GET', '/api/files/complete'],
        ['PATCH', '/api/settings'],
        ['POST', '/api/sessions/:id/rewind'],
        ['POST', '/api/sessions/:id/ide/open-file'],
        ['POST', '/api/remote/pair'],
        ['GET', '/api/sessions/retention-preview'],
        ['POST', '/api/dev/sessions/:id/simulate-compaction'],
      ];
      for (const [method, url] of routes) {
        app.route({
          method: method as any,
          url,
          handler: (req, reply) => {
            reply.send({ url: req.routeOptions.url });
          },
        });
      }
      return app;
    }

    it('rejects strings the URL parser would rewrite before the router sees them', () => {
      for (const [m, p] of [
        ['GET', '/api/sessions/x\\..\\..\\files?path=/etc/passwd'],
        ['POST', '/api/sessions/abc\\rewind#/messages'],
        ['GET', '/api/sessions/retention-preview#'],
        ['GET', '/api/sessions/ab\nc/messages'],
        ['GET', '/api/sessions/abc/messages\t'],
        ['GET', '/api/sessions/%2e%2e/files'],
        ['GET', '/api/sessions/абв'],
      ]) expect(allowedPath(m, p), `${m} ${JSON.stringify(p)}`).toBeNull();
    });

    it('routes every allowed template to itself, and nowhere else', async () => {
      const app = buildRouterApp();
      try {
        for (const [method, template] of ALLOWED_ROUTES) {
          const path = template.replace(/:[^/]+/g, 'abc');
          const approved = allowedPath(method, path);
          expect(approved, `${method} ${template}`).toBe(path);
          const res = await app.inject({ method: method as any, url: approved! });
          expect(res.json().url, `${method} ${template}`).toBe(template);
        }

        // Query strings ride along unchanged and don't affect which route matches.
        for (const [method, path, template] of [
          ['GET', '/api/sessions/abc/messages?limit=30&before=x', '/api/sessions/:id/messages'],
          ['GET', '/api/sessions?cwd=%2Ftmp', '/api/sessions'],
        ] as const) {
          const approved = allowedPath(method, path);
          expect(approved, `${method} ${path}`).toBe(path);
          const res = await app.inject({ method, url: approved! });
          expect(res.json().url, `${method} ${path}`).toBe(template);
        }
      } finally {
        await app.close();
      }
    });
  });
});
