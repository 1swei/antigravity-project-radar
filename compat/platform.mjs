import { homedir } from 'node:os';
import { join } from 'node:path';

export function platformPaths({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  let config;
  let local;
  if (platform === 'win32') {
    config = env.APPDATA || join(home, 'AppData', 'Roaming');
    local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  } else if (platform === 'darwin') {
    config = local = join(home, 'Library', 'Application Support');
  } else if (platform === 'linux') {
    config = env.XDG_CONFIG_HOME || join(home, '.config');
    local = env.XDG_DATA_HOME || join(home, '.local', 'share');
  } else {
    throw new Error('Supported platforms: Windows, Linux, macOS');
  }

  const profile = env.AG_RADAR_PROFILE || join(config, 'Antigravity');
  const profileLog = join(profile, 'logs', 'language_server.log');
  const log = env.AG_RADAR_LOG || (platform === 'darwin' ? join(home, 'Library', 'Logs', 'Antigravity', 'language_server.log') : profileLog);
  const data = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(home, '.gemini', 'antigravity', 'sidecar_data', 'antigravity-project-radar', 'panel', 'data');

  return {
    profile,
    log,
    logCandidates: env.AG_RADAR_LOG
      ? [log]
      : [...new Set([log, profileLog, ...(platform === 'win32' ? [join(home, '.gemini', 'antigravity', 'logs', 'language_server.log')] : [])])],
    settings: join(local, 'AntigravityProjectRadar', 'settings.json'),
    pluginConfig: join(home, '.gemini', 'config', 'config.json'),
    data,
  };
}
