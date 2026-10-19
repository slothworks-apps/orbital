import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerRemoteRoutes } from '../src/api/remoteRoutes.js';
import type { RemoteService } from '../src/remote/service.js';

describe('remote grants endpoints', () => {
  let app: FastifyInstance;
  let mockRemote: Partial<RemoteService>;
  let mockSettings: { get(k: string): string; set(k: string, v: string): void };
  let settingsData: Record<string, string>;

  beforeEach(() => {
    app = Fastify();
    settingsData = {};
    mockSettings = {
      get: (k) => settingsData[k] ?? '',
      set: (k, v) => { settingsData[k] = v; },
    };

    mockRemote = {
      status: () => ({
        macId: 'mac-1',
        group: {
          members: [
            { id: 'mac-1', state: 'self' as const },
            { id: 'phone-1', state: 'online' as const },
            { id: 'phone-2', state: 'online' as const },
          ],
        },
      } as any),
    };

    registerRemoteRoutes(app, mockRemote as RemoteService, undefined, mockSettings);
  });

  describe('GET /api/remote/grants', () => {
    it('lists all members except this device', async () => {
      settingsData['remote_grants'] = JSON.stringify({
        'phone-1': { ide: true },
        'phone-2': { manage: true },
      });

      const res = await app.inject({ method: 'GET', url: '/api/remote/grants' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.grants).toHaveProperty('phone-1');
      expect(body.grants).toHaveProperty('phone-2');
      expect(body.grants).not.toHaveProperty('mac-1'); // self excluded
      expect(body.grants['phone-1'].ide).toBe(true);
      expect(body.grants['phone-2'].manage).toBe(true);
    });

    it('includes defaults for members without stored grants', async () => {
      settingsData['remote_grants'] = JSON.stringify({
        'phone-1': { ide: true },
      });

      const res = await app.inject({ method: 'GET', url: '/api/remote/grants' });
      const body = JSON.parse(res.body);

      // phone-2 has no stored grants, should get all defaults
      expect(body.grants['phone-2']).toEqual({
        sessions: true,
        spawn: true,
        settings: true,
        manage: false,
        ide: false,
      });
    });

    it('handles missing remote_grants setting', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/remote/grants' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.grants['phone-1']).toEqual({
        sessions: true,
        spawn: true,
        settings: true,
        manage: false,
        ide: false,
      });
    });
  });

  describe('PUT /api/remote/grants/:id', () => {
    it('updates a member\'s grants and returns full grants', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/remote/grants/phone-1',
        payload: { ide: true, manage: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.grants).toEqual({
        sessions: true,
        spawn: true,
        settings: true,
        manage: true,
        ide: true,
      });

      // Verify persistence
      const stored = JSON.parse(settingsData['remote_grants']);
      expect(stored['phone-1']).toEqual({ ide: true, manage: true });
    });

    it('persists partial updates preserving existing grants', async () => {
      settingsData['remote_grants'] = JSON.stringify({
        'phone-1': { ide: true },
      });

      const res = await app.inject({
        method: 'PUT',
        url: '/api/remote/grants/phone-1',
        payload: { manage: true },
      });
      expect(res.statusCode).toBe(200);

      // Should preserve ide: true and add manage: true
      const stored = JSON.parse(settingsData['remote_grants']);
      expect(stored['phone-1']).toEqual({ ide: true, manage: true });
    });

    it('rejects unknown grant groups with 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/remote/grants/phone-1',
        payload: { unknown_group: true },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('unknown_group');
      expect(body.group).toBe('unknown_group');
    });

    it('rejects non-boolean values with 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/remote/grants/phone-1',
        payload: { ide: 'yes' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('invalid_value');
      expect(body.group).toBe('ide');
    });

    it('rejects unknown device id with 404', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/remote/grants/unknown-device',
        payload: { ide: true },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('not_found');
    });

    it('rejects update to self with 404', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/remote/grants/mac-1',
        payload: { ide: true },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('not_found');
    });

    it('validates all entries in body before making changes', async () => {
      settingsData['remote_grants'] = JSON.stringify({
        'phone-1': { ide: true },
      });

      const res = await app.inject({
        method: 'PUT',
        url: '/api/remote/grants/phone-1',
        payload: { manage: true, invalid: false },
      });
      expect(res.statusCode).toBe(400);

      // Grants should not have changed due to validation failure
      const stored = JSON.parse(settingsData['remote_grants']);
      expect(stored['phone-1']).toEqual({ ide: true }); // unchanged
    });
  });
});
