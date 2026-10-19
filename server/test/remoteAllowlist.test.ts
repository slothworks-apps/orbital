import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { isAllowed, allowedPath, ALLOWED_ROUTES } from '../src/remote/allowlist.js';

describe('remote allowlist', () => {
  it('every route has exactly one grant group', () => {
    const routes = new Map<string, string>();
    for (const [m, p, g] of ALLOWED_ROUTES) {
      const key = `${m} ${p}`;
      expect(routes.has(key), `${key} defined twice`).toBe(false);
      routes.set(key, g);
    }
  });

  it('allows the session, spawn and catalogue routes', () => {
    for (const [m, p] of [
      ['GET', '/api/sessions'], ['GET', '/api/sessions/abc'], ['GET', '/api/sessions/abc/messages'],
      ['GET', '/api/sessions/abc/messages?limit=30&before=x'],
      ['GET', '/api/sessions/abc/subagents/toolu_1/messages'], ['GET', '/api/sessions/abc/media'],
      ['POST', '/api/sessions'], ['POST', '/api/sessions/abc/messages'],
      ['POST', '/api/sessions/abc/decision/d1'], ['POST', '/api/sessions/abc/interrupt'],
      ['POST', '/api/sessions/abc/model'], ['POST', '/api/sessions/abc/permission-mode'],
      ['POST', '/api/sessions/abc/end'], ['POST', '/api/sessions/abc/reopen'], ['POST', '/api/sessions/abc/clear'],
      ['PATCH', '/api/sessions/abc'], ['PUT', '/api/sessions/abc/pinned'], ['PUT', '/api/sessions/abc/tags'],
      ['POST', '/api/sessions/abc/tasks/t1/stop'], ['GET', '/api/sessions/abc/tasks/t1/output'],
      ['GET', '/api/tags'], ['GET', '/api/projects'], ['GET', '/api/models'], ['GET', '/api/commands'],
      ['GET', '/api/sessions/abc/walkthrough'], ['GET', '/api/sessions/abc/walkthrough/summary'],
      ['GET', '/api/health'], ['GET', '/api/sessions/defaults'],
      // The Claude directory a catalog is read for rides the query string.
      ['GET', '/api/models?claudeDir=2'], ['GET', '/api/commands?cwd=/w/x&claudeDir=2'],
      ['GET', '/api/mcpjson?cwd=/w/x&claudeDirId=2'],
      // The `.mcp.json` question's *View file*, read where the session would run.
      ['GET', '/api/mcpjson/file?cwd=/w/x&server=a'],
    ]) expect(isAllowed(m, p), `${m} ${p}`).toBe(true);
  });
  it('allows what a desktop drives a session with, and what a federated Settings needs', () => {
    for (const [m, p] of [
      ['POST', '/api/sessions/abc/retitle'], ['POST', '/api/sessions/abc/walkthrough/narrate'],
      ['POST', '/api/sessions/abc/harness'], ['PATCH', '/api/sessions/abc/harness'], ['DELETE', '/api/sessions/abc/harness'],
      ['POST', '/api/sessions/abc/harness/carry'], ['GET', '/api/sessions/abc/harness/steps/1/diff'],
      ['DELETE', '/api/sessions/abc/rewind'],
      ['GET', '/api/sessions/abc/mcp'], ['POST', '/api/sessions/abc/mcp'], ['POST', '/api/sessions/abc/mcp/restart'],
      ['PUT', '/api/sessions/abc/mcp/github'], ['DELETE', '/api/sessions/abc/mcp/github'],
      ['GET', '/api/sessions/abc/mcp/github/config'], ['POST', '/api/sessions/abc/mcp/github/login'],
      ['GET', '/api/stats/sessions/abc?claudeDir=1'],
      ['GET', '/api/files?session=abc&path=src%2Fa.ts'], ['GET', '/api/files/complete?cwd=/w/x&prefix=sr'],
      ['GET', '/api/commands/content?cwd=/w/x&name=review'],
      ['GET', '/api/dirs'], ['GET', '/api/dirs?path=%2FUsers%2Fx'],
      ['GET', '/api/settings'], ['PATCH', '/api/settings'],
      ['POST', '/api/tags'], ['PATCH', '/api/tags/1'], ['DELETE', '/api/tags/1'],
      ['GET', '/api/tag-rules'], ['POST', '/api/tag-rules'], ['POST', '/api/tag-rules/preview'],
      ['PATCH', '/api/tag-rules/2'], ['DELETE', '/api/tag-rules/2'],
      ['GET', '/api/harness/templates'], ['POST', '/api/harness/templates'], ['POST', '/api/harness/templates/draft'],
      ['PUT', '/api/harness/templates/3'], ['DELETE', '/api/harness/templates/3'],
      ['POST', '/api/harness/templates/3/duplicate'], ['GET', '/api/harness/projects'],
      ['GET', '/api/harness/interview'], ['POST', '/api/harness/interview'],
      ['GET', '/api/limits'], ['POST', '/api/limits/refresh'], ['GET', '/api/stats/overview'], ['GET', '/api/claude-dirs'],
    ]) expect(isAllowed(m, p), `${m} ${p}`).toBe(true);
  });
  it('allows IDE and manage routes which require grants', () => {
    for (const [m, p, expectedGroup] of [
      ['GET', '/api/sessions/abc/ide/open-files', 'ide'],
      ['POST', '/api/sessions/abc/ide/open-file', 'ide'],
      ['GET', '/api/sessions/abc/ide/diagnostics', 'ide'],
      ['GET', '/api/errors', 'manage'],
      ['POST', '/api/errors/seen', 'manage'],
      ['GET', '/api/claude-dirs', 'settings'],
      ['POST', '/api/claude-dirs', 'manage'],
      ['PATCH', '/api/claude-dirs/2', 'manage'],
      ['DELETE', '/api/claude-dirs/2', 'manage'],
      ['POST', '/api/models/validate', 'manage'],
      ['POST', '/api/branch-status/refresh', 'manage'],
      ['GET', '/api/sessions/retention-preview', 'manage'],
      ['GET', '/api/session-instructions/tips', 'manage'],
      ['POST', '/api/limits/refresh', 'settings'],
      ['GET', '/api/stats/overview', 'settings'],
      ['GET', '/api/gh-status', 'manage'],
    ] as const) {
      const result = allowedPath(m, p);
      expect(result, `${m} ${p}`).not.toBeNull();
      if (result) expect(result.group).toBe(expectedGroup);
    }
  });

  it('denies what acts on that machine\'s screen, the dev tools, auth, remote, presence, terminals and binary reads', () => {
    for (const [m, p] of [
      ['GET', '/api/files/image'], ['GET', '/api/files/image?session=abc&path=a.png'], ['GET', '/api/images/abc.png'],
      ['PATCH', '/api/settings/'],
      ['POST', '/api/dev/sessions/abc/simulate-compaction'],
      ['POST', '/api/attachments'], ['POST', '/api/sessions/abc/attachments'],
      ['GET', '/api/auth'], ['PUT', '/api/presence'],
      ['GET', '/api/remote'], ['POST', '/api/remote/pair'], ['DELETE', '/api/remote/devices/x'],
      ['POST', '/api/remote/leave'], ['POST', '/api/remote/restart'], ['POST', '/api/remote/pair/confirm'],
      ['GET', '/api/sessions/abc/terminals'], ['POST', '/api/sessions/abc/terminals'],
      ['POST', '/api/terminals/t1/restart'], ['DELETE', '/api/terminals/t1'],
      ['GET', '/ws'], ['GET', '/'], ['GET', '/index.html'],
      // `defaults` is a literal, never an id: no other method or shape reaches it.
      ['GET', '/api/sessions/defaults/'], ['GET', '/api/sessions/defaults/x'], ['POST', '/api/sessions/defaults'],
      ['PATCH', '/api/sessions/defaults'],
      // Nor are the new literals a parameter: each reaches its own route, for its one method.
      ['PUT', '/api/sessions/abc/mcp/restart'], ['DELETE', '/api/sessions/abc/mcp/restart'],
      ['GET', '/api/sessions/abc/mcp/restart/config'],
      ['PATCH', '/api/tag-rules/preview'], ['DELETE', '/api/tag-rules/preview'],
      ['PUT', '/api/harness/templates/draft'], ['DELETE', '/api/harness/templates/draft'],
      ['POST', '/api/harness/templates/draft/duplicate'],
      ['GET', '/api/sessions/count/mcp'], ['GET', '/api/stats/sessions/defaults'],
      // Traversal and canonical-string tricks toward the never-on routes.
      ['GET', '/api/sessions/abc/mcp/..%2Fide/config'], ['GET', '/api/sessions/abc/mcp/%2e%2e/config'],
      ['GET', '/api/files/../files/image'], ['GET', '/api/files\\image'], ['GET', '/api/dirs/../images/a.png'],
      ['PATCH', '/api/settings#'], ['GET', '/api/stats/sessions/../../remote'],
    ]) expect(isAllowed(m, p), `${m} ${p}`).toBe(false);
  });
  describe('harness gate and limit wait', () => {
    const added: ReadonlyArray<readonly [string, string]> = [
      ['POST', '/api/sessions/abc/harness/steps/3/approve'],
      ['POST', '/api/sessions/abc/harness/steps/3/reopen'],
      ['POST', '/api/sessions/abc/harness/steps/3/go-back'],
      ['POST', '/api/sessions/abc/harness/steps/3/decide-myself'],
      ['POST', '/api/sessions/abc/limit-wait/cancel'],
      ['POST', '/api/sessions/abc/limit-wait/undo'],
    ];

    it('allows each route for its one method only', () => {
      for (const [method, path] of added) {
        for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
          expect(isAllowed(m, path), `${m} ${path}`).toBe(m === method);
        }
      }
    });

    it('keeps the neighbours denied', () => {
      for (const [m, p] of [
        ['GET', '/api/sessions/abc/rewind'],
        ['PUT', '/api/sessions/abc/harness'],
        ['GET', '/api/sessions/abc/harness/carry'],
        ['POST', '/api/sessions/abc/harness/steps/1/diff'],
        ['GET', '/api/files/image'],
      ]) expect(isAllowed(m, p), `${m} ${p}`).toBe(false);
    });

    it('refuses a step index that is not one plain segment', () => {
      for (const index of ['..', '.', '%2e', '%2e%2e', '', '1%2F..']) {
        const p = `/api/sessions/abc/harness/steps/${index}/approve`;
        expect(isAllowed('POST', p), JSON.stringify(p)).toBe(false);
      }
      expect(isAllowed('POST', '/api/sessions/abc/harness/steps/1/approve/')).toBe(false);
      expect(isAllowed('GET', '/api/sessions/abc/harness/')).toBe(false);
      expect(isAllowed('POST', '/api/sessions/abc/limit-wait/cancel/')).toBe(false);
    });
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
      // ALLOWED_ROUTES now includes ide and manage routes (with grant groups).
      // Extract just the method and template from ALLOWED_ROUTES (skip the group).
      const allowed: ReadonlyArray<readonly [string, string]> = ALLOWED_ROUTES.map(([m, t]) => [m, t]);
      const routes: ReadonlyArray<readonly [string, string]> = [
        ...allowed,
        ['GET', '/api/files/image'],
        ['GET', '/api/images/:ref'],
        ['GET', '/api/sessions/:id/terminals'],
        ['POST', '/api/remote/pair'],
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
        for (const [method, template] of ALLOWED_ROUTES.map(([m, t]) => [m, t] as const)) {
          const path = template.replace(/:[^/]+/g, 'abc');
          const approved = allowedPath(method, path);
          expect(approved?.path, `${method} ${template}`).toBe(path);
          const res = await app.inject({ method: method as any, url: approved!.path });
          expect(res.json().url, `${method} ${template}`).toBe(template);
        }

        // Query strings ride along unchanged and don't affect which route matches.
        for (const [method, path, template] of [
          ['GET', '/api/sessions/abc/messages?limit=30&before=x', '/api/sessions/:id/messages'],
          ['GET', '/api/sessions?cwd=%2Ftmp', '/api/sessions'],
        ] as const) {
          const approved = allowedPath(method, path);
          expect(approved?.path, `${method} ${path}`).toBe(path);
          const res = await app.inject({ method, url: approved!.path });
          expect(res.json().url, `${method} ${path}`).toBe(template);
        }
      } finally {
        await app.close();
      }
    });
  });
  it('a member cannot make this device join another', () => {
    expect(isAllowed('POST', '/api/remote/join')).toBe(false);
  });
  it('a member reads and starts this device\'s update, and nothing beside it', () => {
    expect(isAllowed('GET', '/api/server/update')).toBe(true);
    expect(isAllowed('POST', '/api/server/update')).toBe(true);
    expect(isAllowed('DELETE', '/api/server/update')).toBe(true);
    for (const [m, p] of [
      ['PUT', '/api/server/update'], ['PATCH', '/api/server/update'], ['DELETE', '/api/server/update/'],
      ['DELETE', '/api/server/update/x'], ['DELETE', '/api/server'],
      ['GET', '/api/server'], ['POST', '/api/server'], ['POST', '/api/server/update/x'], ['POST', '/api/server/updates'],
      ['POST', '/api/server/restart'], ['POST', '/api/server/update/'], ['POST', '/api/server/%75pdate'],
    ]) expect(isAllowed(m, p), `${m} ${p}`).toBe(false);
  });
});
