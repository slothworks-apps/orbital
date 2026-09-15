import { homedir } from 'node:os';
import { join } from 'node:path';

const claudeDir = process.env.ORBITAL_CLAUDE_DIR ?? join(homedir(), '.claude');
const dataDir =
  process.env.ORBITAL_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'orbital');

export const CONFIG = {
  claudeDir,
  projectsDir: join(claudeDir, 'projects'),
  sessionsDir: join(claudeDir, 'sessions'),
  dataDir,
  dbPath: join(dataDir, 'index.db'),
  port: Number(process.env.ORBITAL_PORT ?? 4737),
};
