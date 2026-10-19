import { homedir } from 'node:os';
import { join } from 'node:path';
import { orbitalDataDir } from '@orbital/shared/dataDir';

const claudeDir = process.env.ORBITAL_CLAUDE_DIR ?? join(homedir(), '.claude');
const dataDir = orbitalDataDir({ env: process.env, home: homedir(), platform: process.platform });

export const CONFIG = {
  claudeDir,
  projectsDir: join(claudeDir, 'projects'),
  sessionsDir: join(claudeDir, 'sessions'),
  dataDir,
  dbPath: join(dataDir, 'index.db'),
  port: Number(process.env.ORBITAL_PORT ?? 4737),
};
