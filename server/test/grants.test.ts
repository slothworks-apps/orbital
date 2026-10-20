import { describe, it, expect } from 'vitest';
import { parseGrants, getMemberGrants, memberHasGrant, memberRefusal, ALL_GRANT_GROUPS } from '../src/remote/grants.js';
import { Hub } from '../src/api/hub.js';
import { createImageStore } from '../src/images/store.js';
import { LIMITS_TOPIC } from '@orbital/shared/limits';
import { allowedPath } from '../src/remote/allowlist.js';
import { LIMITS_GRANT, ServingHalf, memberMayWatch, ownLimitsFrame } from '../src/remote/servingHalf.js';
import { makeTmpDir } from './tmp.js';

describe('grants', () => {
  describe('parseGrants', () => {
    it('parses valid JSON grants', () => {
      const raw = JSON.stringify({
        device1: { sessions: false },
        device2: { ide: true, manage: true },
      });
      const result = parseGrants(raw);
      expect(result).toEqual({
        device1: { sessions: false },
        device2: { ide: true, manage: true },
      });
    });

    it('returns empty object for malformed JSON', () => {
      expect(parseGrants('not json')).toEqual({});
      expect(parseGrants('{ invalid }')).toEqual({});
    });

    it('returns empty object for non-object JSON', () => {
      expect(parseGrants('[]')).toEqual({});
      expect(parseGrants('123')).toEqual({});
      expect(parseGrants('null')).toEqual({});
    });

    it('ignores non-object values', () => {
      const raw = JSON.stringify({
        device1: { sessions: false },
        device2: 'not an object',
        device3: null,
      });
      const result = parseGrants(raw);
      expect(result).toEqual({
        device1: { sessions: false },
      });
    });

    it('returns empty object for undefined', () => {
      expect(parseGrants(undefined)).toEqual({});
    });

    it('returns empty object for empty string', () => {
      expect(parseGrants('')).toEqual({});
    });
  });

  describe('getMemberGrants', () => {
    it('applies defaults to missing member', () => {
      const grants = {};
      const result = getMemberGrants(grants, 'unknown');
      expect(result).toEqual({
        sessions: true,
        spawn: true,
        settings: true,
        manage: false,
        ide: false,
      });
    });

    it('merges stored overrides with defaults', () => {
      const grants = {
        device1: { sessions: false, ide: true },
      };
      const result = getMemberGrants(grants, 'device1');
      expect(result).toEqual({
        sessions: false,
        spawn: true,
        settings: true,
        manage: false,
        ide: true,
      });
    });

    it('applies defaults to all groups not in stored', () => {
      const grants = {
        device1: { sessions: false },
      };
      const result = getMemberGrants(grants, 'device1');
      expect(result.spawn).toBe(true);
      expect(result.settings).toBe(true);
      expect(result.manage).toBe(false);
    });
  });

  describe('memberHasGrant', () => {
    it('checks grant for member with stored overrides', () => {
      const grants = {
        device1: { sessions: false, ide: true },
      };
      expect(memberHasGrant(grants, 'device1', 'sessions')).toBe(false);
      expect(memberHasGrant(grants, 'device1', 'ide')).toBe(true);
      expect(memberHasGrant(grants, 'device1', 'spawn')).toBe(true); // default
    });

    it('checks grant for unknown member using defaults', () => {
      const grants = {};
      expect(memberHasGrant(grants, 'unknown', 'sessions')).toBe(true);
      expect(memberHasGrant(grants, 'unknown', 'manage')).toBe(false);
      expect(memberHasGrant(grants, 'unknown', 'ide')).toBe(false);
    });
  });

  describe('ALL_GRANT_GROUPS', () => {
    it('contains all grant groups', () => {
      expect(ALL_GRANT_GROUPS).toContain('sessions');
      expect(ALL_GRANT_GROUPS).toContain('spawn');
      expect(ALL_GRANT_GROUPS).toContain('settings');
      expect(ALL_GRANT_GROUPS).toContain('manage');
      expect(ALL_GRANT_GROUPS).toContain('ide');
    });
  });
});

describe('member grants', () => {
  describe('getMemberGrants with non-boolean stored values', () => {
    it('falls back to default when stored value is not a boolean', () => {
      const grants = {
        device1: { sessions: 'yes' as any, spawn: null as any, settings: undefined as any },
      };
      const result = getMemberGrants(grants, 'device1');
      // Non-boolean values should fall back to defaults
      expect(result.sessions).toBe(true); // default
      expect(result.spawn).toBe(true); // default
      expect(result.settings).toBe(true); // default
      expect(result.manage).toBe(false); // default
      expect(result.ide).toBe(false); // default
    });

    it('uses boolean values even when mixed with non-booleans', () => {
      const grants = {
        device1: {
          sessions: false,
          spawn: 'invalid' as any,
          ide: true,
        },
      };
      const result = getMemberGrants(grants, 'device1');
      expect(result.sessions).toBe(false); // explicit false
      expect(result.spawn).toBe(true); // defaults to true because value is not boolean
      expect(result.ide).toBe(true); // explicit true
      expect(result.settings).toBe(true); // default
      expect(result.manage).toBe(false); // default
    });
  });

  describe('memberRefusal', () => {
    it('returns not_granted message for 403 with not_granted error', () => {
      const msg = memberRefusal(403, { error: 'not_granted', grant: 'ide' }, null, 'device-x');
      expect(msg).toContain('has not granted this device');
      expect(msg).toContain('ide');
      expect(msg).toContain("Settings → Devices");
    });

    it('uses device name when provided', () => {
      const msg = memberRefusal(403, { error: 'not_granted', grant: 'manage' }, 'iPhone', 'device-x');
      expect(msg).toContain('iPhone');
      expect(msg).toContain('manage');
    });

    it('returns member_offline message for 409 error', () => {
      const msg = memberRefusal(409, { error: 'member_offline' }, null, 'device-x');
      expect(msg).toContain('device-x');
      expect(msg).toContain('offline');
    });

    it('returns unknown_device message for 404 error', () => {
      const msg = memberRefusal(404, { error: 'unknown_device' }, null, 'device-y');
      expect(msg).toContain('No device in the group has id');
      expect(msg).toContain('device-y');
    });

    it('returns null for unrelated status codes', () => {
      expect(memberRefusal(200, { ok: true }, null, 'device-x')).toBeNull();
      expect(memberRefusal(500, { error: 'internal' }, null, 'device-x')).toBeNull();
    });

    it('returns null when body structure is wrong', () => {
      expect(memberRefusal(403, 'not an object', null, 'device-x')).toBeNull();
      expect(memberRefusal(403, { error: 'not_granted' }, null, 'device-x')).toBeNull(); // missing grant
    });
  });
});

describe('ServingHalf and grants', () => {
  function serve(grants: () => string, hub = new Hub()) {
    const dir = makeTmpDir('grants');
    const asked: string[] = [];
    const out: any[] = [];
    const serving = new ServingHalf({
      deviceId: 'm1', hub, images: createImageStore(dir), imagesDir: dir,
      inject: async (req) => { asked.push(`${req.method} ${req.url}`); return { statusCode: 200, body: '{}' }; },
      files: () => ({ status: 404 }), notifications: { get: () => ({}) as never, set: () => {} }, onSeen: () => {},
      getGrants: grants,
    });
    serving.open({ json: (msg) => { out.push(msg); }, inner: () => {} });
    const ask = async (id: number, method: string, path: string) => {
      serving.ask({ t: 'http', id, method, path } as never);
      await new Promise((r) => setTimeout(r, 0));
      return out.find((m) => m.t === 'http_res' && m.id === id);
    };
    return { ask, asked, serving, out };
  }

  it('serves a default-on group, refuses a default-off one as not_granted, and serves it once granted, live', async () => {
    let raw = '';
    const { ask, asked, serving } = serve(() => raw);
    expect((await ask(1, 'GET', '/api/sessions')).status).toBe(200);
    expect(await ask(2, 'GET', '/api/sessions/abc/ide/diagnostics'))
      .toMatchObject({ status: 403, body: { error: 'not_granted', grant: 'ide' } });
    raw = JSON.stringify({ m1: { ide: true, sessions: false } });
    expect((await ask(3, 'GET', '/api/sessions/abc/ide/diagnostics')).status).toBe(200);
    expect(await ask(4, 'GET', '/api/sessions')).toMatchObject({ status: 403, body: { error: 'not_granted', grant: 'sessions' } });
    expect(asked).toEqual(['GET /api/sessions', 'GET /api/sessions/abc/ide/diagnostics']);
    serving.reset();
  });

  it('a route on no group stays not_allowed', async () => {
    const { ask, serving } = serve(() => '');
    expect(await ask(1, 'GET', '/api/remote')).toMatchObject({ status: 403, body: { error: 'not_allowed' } });
    serving.reset();
  });

  it('the limits topic follows the grant of GET /api/limits, on subscribe and on every frame', () => {
    expect(allowedPath('GET', '/api/limits')?.group).toBe(LIMITS_GRANT);
    const hub = new Hub();
    let raw = JSON.stringify({ m1: { [LIMITS_GRANT]: false } });
    const { serving, out } = serve(() => raw, hub);
    const frames = () => out.filter((m) => m.t === 'ws' && m.frame.topic === LIMITS_TOPIC);
    serving.ask({ t: 'ws', type: 'subscribe', topic: LIMITS_TOPIC } as never);
    hub.publish(LIMITS_TOPIC, { event: 'limits', limits: { dirs: [] } });
    expect(frames()).toHaveLength(0);

    raw = '';
    serving.ask({ t: 'ws', type: 'subscribe', topic: LIMITS_TOPIC } as never);
    hub.publish(LIMITS_TOPIC, { event: 'limits', limits: { dirs: [] } });
    expect(frames()).toHaveLength(1);

    // Taken back while the subscription stands: the next frame stays here.
    raw = JSON.stringify({ m1: { [LIMITS_GRANT]: false } });
    hub.publish(LIMITS_TOPIC, { event: 'limits', limits: { dirs: [] } });
    expect(frames()).toHaveLength(1);
    serving.reset();
  });
});

describe('the limits topic for a member', () => {
  it('may be watched', () => {
    expect(memberMayWatch(LIMITS_TOPIC)).toBe(true);
  });

  it('carries only this device\'s own directories; any other frame is left as it is', () => {
    const own = { id: 1, account: 'a@example.com' };
    const theirs = { id: 1, account: 'b@example.com', machine: { id: 'm2', name: 'Studio' } };
    const frame = { topic: LIMITS_TOPIC, event: 'limits', limits: { dirs: [own, theirs, { id: 2, machine: null }] } };
    expect(ownLimitsFrame(frame)).toEqual({ ...frame, limits: { dirs: [own, { id: 2, machine: null }] } });
    const sessions = { topic: 'sessions', event: 'upsert', limits: { dirs: [theirs] } };
    expect(ownLimitsFrame(sessions)).toBe(sessions);
    const odd = { topic: LIMITS_TOPIC, event: 'limits', limits: null };
    expect(ownLimitsFrame(odd)).toBe(odd);
    expect(ownLimitsFrame(null)).toBeNull();
  });
});
