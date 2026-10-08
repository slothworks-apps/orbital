import { and, eq, inArray } from 'drizzle-orm';
import type { OrbitalDb } from '../db/database.js';
import { mcpjsonApprovals } from '../db/schema.js';
import type { McpjsonFingerprints } from './mcpjson.js';

/**
 * `McpjsonFingerprints` over the `mcpjson_approvals` table (spec
 * 2026-10-08-mcpjson-approval-design § Behaviour 4). Stateless: every read
 * goes to the database, so the runner and the routes can each hold one.
 */
export function dbFingerprints(db: OrbitalDb, now: () => number = Date.now): McpjsonFingerprints {
  return {
    forProject(project) {
      const rows = db
        .select({ name: mcpjsonApprovals.name, hash: mcpjsonApprovals.hash })
        .from(mcpjsonApprovals)
        .where(eq(mcpjsonApprovals.project, project))
        .all();
      return new Map(rows.map((r) => [r.name, r.hash]));
    },
    update(project, allowed, denied) {
      db.transaction((tx) => {
        const approvedAt = now();
        for (const [name, hash] of allowed) {
          tx.insert(mcpjsonApprovals)
            .values({ project, name, hash, approvedAt })
            .onConflictDoUpdate({ target: [mcpjsonApprovals.project, mcpjsonApprovals.name], set: { hash, approvedAt } })
            .run();
        }
        if (denied.length > 0) {
          tx.delete(mcpjsonApprovals)
            .where(and(eq(mcpjsonApprovals.project, project), inArray(mcpjsonApprovals.name, [...denied])))
            .run();
        }
      });
    },
  };
}
