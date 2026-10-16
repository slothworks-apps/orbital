/**
 * The Macs this Mac is a client of, in the data dir beside the identity
 * (spec 2026-10-06-peer-macs-design § 1). One client identity per peer: the
 * relay holds one socket per device, and this Mac's own identity already
 * holds its host socket. The file's mode is the whole protection, as for
 * `remote-identity.json`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const PEERS_FILE = 'remote-peers.json';

const StoredPeer = z.object({
  /** The peer's host id: its public key, as the QR named it. */
  mac: z.string(),
  name: z.string(),
  relayUrl: z.string(),
  relaySecret: z.string().optional(),
  /** This Mac's client identity for that peer, base64url. */
  secretKey: z.string(),
  pairedAt: z.number(),
});
export type StoredPeer = z.infer<typeof StoredPeer>;

export class PeerStore {
  private readonly path: string;

  constructor(private readonly dataDir: string) {
    this.path = join(dataDir, PEERS_FILE);
  }

  list(): StoredPeer[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed = z.array(StoredPeer).safeParse(JSON.parse(readFileSync(this.path, 'utf8')));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  put(peer: StoredPeer): void {
    this.write([...this.list().filter((p) => p.mac !== peer.mac), peer]);
  }

  remove(mac: string): boolean {
    const all = this.list();
    const rest = all.filter((p) => p.mac !== mac);
    if (rest.length === all.length) return false;
    this.write(rest);
    return true;
  }

  private write(peers: StoredPeer[]): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(peers));
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}
