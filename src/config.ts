import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_API_URL = 'https://api.vibemock.bid';
export const PROJECT_CONFIG_FILENAME = '.vibemock.json';

export const CONFIG_KEYS = [
  'api_url',
  'token',
  'default_app',
  'default_env',
  'callback_url',
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export interface VibeMockConfigFile {
  api_url?: string;
  token?: string;
  default_app?: string;
  default_env?: string;
  callback_url?: string;
}

export interface VibeMockProjectConfig {
  app?: string;
  env?: string;
  callback_url?: string;
  api_url?: string;
}

export type ValueSource = 'flag' | 'env' | 'project' | 'config' | 'default' | 'unset';

export interface ResolvedConfig {
  configPath: string;
  projectConfigPath: string | null;
  apiUrl: string;
  apiUrlSource: ValueSource;
  token?: string;
  tokenSource: ValueSource;
  defaultApp?: string;
  defaultAppSource: ValueSource;
  defaultEnv?: string;
  defaultEnvSource: ValueSource;
  callbackUrl?: string;
  callbackUrlSource: ValueSource;
}

export interface ResolveConfigOverrides {
  apiUrl?: string;
  token?: string;
  defaultApp?: string;
  defaultEnv?: string;
  callbackUrl?: string;
  configPath?: string;
  cwd?: string;
}

export function getConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.VIBEMOCK_CONFIG_PATH?.trim();
  if (custom) {
    return path.resolve(custom);
  }
  const home = env.HOME?.trim() || os.homedir();
  return path.join(home, '.config', 'vibemock', 'config.json');
}

export function normalizeApiUrl(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid api_url "${raw}". Expected an http:// or https:// URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid api_url "${raw}". Protocol must be http: or https:.`);
  }
  return trimmed.replace(/\/+$/, '');
}

export function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

export function readConfigFile(configPath = getConfigPath()): VibeMockConfigFile {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  const raw = fs.readFileSync(configPath, 'utf8').trim();
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse config file at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid config file at ${configPath}: expected a JSON object.`);
  }
  const obj = parsed as Record<string, unknown>;
  const result: VibeMockConfigFile = {};
  for (const key of CONFIG_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      result[key] = value.trim();
    }
  }
  return result;
}

export function writeConfigFile(config: VibeMockConfigFile, configPath = getConfigPath()): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const clean: VibeMockConfigFile = {};
  for (const key of CONFIG_KEYS) {
    const val = config[key]?.trim();
    if (val) {
      clean[key] = key === 'api_url' ? normalizeApiUrl(val) : val;
    }
  }

  fs.writeFileSync(configPath, `${JSON.stringify(clean, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Ignore chmod failures on platforms/filesystems that do not support POSIX modes.
  }
}

export function updateConfigValues(
  updates: Partial<Record<ConfigKey, string | undefined>>,
  configPath = getConfigPath(),
): VibeMockConfigFile {
  const current = readConfigFile(configPath);
  const next: VibeMockConfigFile = { ...current };
  for (const key of CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      const value = updates[key];
      if (value === undefined || value.trim() === '') {
        delete next[key];
      } else {
        next[key] = key === 'api_url' ? normalizeApiUrl(value) : value.trim();
      }
    }
  }
  writeConfigFile(next, configPath);
  return next;
}

export function findProjectConfigPath(startDir: string = process.cwd()): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, PROJECT_CONFIG_FILENAME);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function readProjectConfigFile(projectPath: string): VibeMockProjectConfig {
  if (!fs.existsSync(projectPath)) {
    return {};
  }
  const raw = fs.readFileSync(projectPath, 'utf8').trim();
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse project config at ${projectPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid project config at ${projectPath}: expected a JSON object.`);
  }
  const obj = parsed as Record<string, unknown>;
  const result: VibeMockProjectConfig = {};
  if (typeof obj.app === 'string' && obj.app.trim()) result.app = obj.app.trim();
  if (typeof obj.env === 'string' && obj.env.trim()) result.env = obj.env.trim();
  if (typeof obj.callback_url === 'string' && obj.callback_url.trim()) {
    result.callback_url = obj.callback_url.trim();
  }
  if (typeof obj.api_url === 'string' && obj.api_url.trim()) {
    result.api_url = normalizeApiUrl(obj.api_url);
  }
  return result;
}

export function writeProjectConfigFile(
  config: VibeMockProjectConfig,
  projectPath: string,
): VibeMockProjectConfig {
  const clean: VibeMockProjectConfig = {};
  if (config.app?.trim()) clean.app = config.app.trim();
  if (config.env?.trim()) clean.env = config.env.trim();
  if (config.callback_url?.trim()) clean.callback_url = config.callback_url.trim();
  if (config.api_url?.trim()) clean.api_url = normalizeApiUrl(config.api_url);
  fs.writeFileSync(projectPath, `${JSON.stringify(clean, null, 2)}\n`, { encoding: 'utf8' });
  return clean;
}

export function resolveRuntimeConfig(
  overrides: ResolveConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const configPath = overrides.configPath ? path.resolve(overrides.configPath) : getConfigPath(env);
  const fileConfig = readConfigFile(configPath);
  const projectConfigPath = overrides.cwd
    ? findProjectConfigPath(overrides.cwd)
    : findProjectConfigPath();
  const projectConfig = projectConfigPath ? readProjectConfigFile(projectConfigPath) : {};

  let apiUrl = DEFAULT_API_URL;
  let apiUrlSource: ValueSource = 'default';
  if (overrides.apiUrl?.trim()) {
    apiUrl = normalizeApiUrl(overrides.apiUrl);
    apiUrlSource = 'flag';
  } else if (env.VIBEMOCK_API_URL?.trim()) {
    apiUrl = normalizeApiUrl(env.VIBEMOCK_API_URL);
    apiUrlSource = 'env';
  } else if (projectConfig.api_url) {
    apiUrl = normalizeApiUrl(projectConfig.api_url);
    apiUrlSource = 'project';
  } else if (fileConfig.api_url) {
    apiUrl = normalizeApiUrl(fileConfig.api_url);
    apiUrlSource = 'config';
  }

  let token: string | undefined;
  let tokenSource: ValueSource = 'unset';
  if (overrides.token?.trim()) {
    token = overrides.token.trim();
    tokenSource = 'flag';
  } else if (env.VIBEMOCK_TOKEN?.trim()) {
    token = env.VIBEMOCK_TOKEN.trim();
    tokenSource = 'env';
  } else if (fileConfig.token) {
    token = fileConfig.token;
    tokenSource = 'config';
  }

  let defaultApp: string | undefined;
  let defaultAppSource: ValueSource = 'unset';
  if (overrides.defaultApp?.trim()) {
    defaultApp = overrides.defaultApp.trim();
    defaultAppSource = 'flag';
  } else if (env.VIBEMOCK_DEFAULT_APP?.trim()) {
    defaultApp = env.VIBEMOCK_DEFAULT_APP.trim();
    defaultAppSource = 'env';
  } else if (projectConfig.app) {
    defaultApp = projectConfig.app;
    defaultAppSource = 'project';
  } else if (fileConfig.default_app) {
    defaultApp = fileConfig.default_app;
    defaultAppSource = 'config';
  }

  let defaultEnv: string | undefined;
  let defaultEnvSource: ValueSource = 'unset';
  if (overrides.defaultEnv?.trim()) {
    defaultEnv = overrides.defaultEnv.trim();
    defaultEnvSource = 'flag';
  } else if (env.VIBEMOCK_DEFAULT_ENV?.trim()) {
    defaultEnv = env.VIBEMOCK_DEFAULT_ENV.trim();
    defaultEnvSource = 'env';
  } else if (projectConfig.env) {
    defaultEnv = projectConfig.env;
    defaultEnvSource = 'project';
  } else if (fileConfig.default_env) {
    defaultEnv = fileConfig.default_env;
    defaultEnvSource = 'config';
  }

  let callbackUrl: string | undefined;
  let callbackUrlSource: ValueSource = 'unset';
  if (overrides.callbackUrl?.trim()) {
    callbackUrl = overrides.callbackUrl.trim();
    callbackUrlSource = 'flag';
  } else if (env.VIBEMOCK_CALLBACK_URL?.trim()) {
    callbackUrl = env.VIBEMOCK_CALLBACK_URL.trim();
    callbackUrlSource = 'env';
  } else if (projectConfig.callback_url) {
    callbackUrl = projectConfig.callback_url;
    callbackUrlSource = 'project';
  } else if (fileConfig.callback_url) {
    callbackUrl = fileConfig.callback_url;
    callbackUrlSource = 'config';
  }

  return {
    configPath,
    projectConfigPath,
    apiUrl,
    apiUrlSource,
    token,
    tokenSource,
    defaultApp,
    defaultAppSource,
    defaultEnv,
    defaultEnvSource,
    callbackUrl,
    callbackUrlSource,
  };
}

export function maskSecret(secret: string | undefined): string | null {
  if (!secret) return null;
  if (secret.length <= 8) {
    return `${secret.slice(0, 2)}******`;
  }
  return `${secret.slice(0, 8)}...${secret.slice(-4)}`;
}
