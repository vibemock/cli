import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_API_URL,
  PROJECT_CONFIG_FILENAME,
  findProjectConfigPath,
  getConfigPath,
  maskSecret,
  readConfigFile,
  resolveRuntimeConfig,
  updateConfigValues,
  writeProjectConfigFile,
} from '../src/config.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibemock-cli-config-'));
}

describe('config', () => {
  it('defaults config path to ~/.config/vibemock/config.json and api_url to DEFAULT_API_URL', () => {
    const tmpHome = makeTempDir();
    try {
      const env = { HOME: tmpHome } as NodeJS.ProcessEnv;
      assert.equal(getConfigPath(env), path.join(tmpHome, '.config', 'vibemock', 'config.json'));

      const resolved = resolveRuntimeConfig({}, env);
      assert.equal(resolved.apiUrl, DEFAULT_API_URL);
      assert.equal(resolved.apiUrlSource, 'default');
      assert.equal(resolved.token, undefined);
      assert.equal(resolved.tokenSource, 'unset');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('writes, updates, unsets config file with 0600 permissions and falls back to default api_url', () => {
    const tmpHome = makeTempDir();
    try {
      const configPath = path.join(tmpHome, '.config', 'vibemock', 'config.json');
      updateConfigValues(
        {
          api_url: 'http://api.localhost:8787/',
          token: 'vmk_inspect_secret_123456',
          default_app: 'wxpay-01',
          default_env: 'agent-dev',
        },
        configPath,
      );

      assert.equal(fs.existsSync(configPath), true);
      const mode = fs.statSync(configPath).mode & 0o777;
      assert.equal(mode, 0o600);

      const stored = readConfigFile(configPath);
      assert.equal(stored.api_url, 'http://api.localhost:8787');
      assert.equal(stored.token, 'vmk_inspect_secret_123456');
      assert.equal(stored.default_app, 'wxpay-01');
      assert.equal(stored.default_env, 'agent-dev');

      // Unset api_url -> falls back to DEFAULT_API_URL
      updateConfigValues({ api_url: undefined }, configPath);
      const resolved = resolveRuntimeConfig({ configPath }, {});
      assert.equal(resolved.apiUrl, DEFAULT_API_URL);
      assert.equal(resolved.apiUrlSource, 'default');
      assert.equal(resolved.token, 'vmk_inspect_secret_123456');
      assert.equal(resolved.tokenSource, 'config');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('respects precedence: flag > env > config > default', () => {
    const tmpHome = makeTempDir();
    try {
      const configPath = path.join(tmpHome, '.config', 'vibemock', 'config.json');
      updateConfigValues(
        {
          api_url: 'https://from-config.example.com',
          token: 'token-from-config',
        },
        configPath,
      );

      const fromEnv = resolveRuntimeConfig(
        { configPath },
        {
          VIBEMOCK_API_URL: 'https://from-env.example.com',
          VIBEMOCK_TOKEN: 'token-from-env',
        },
      );
      assert.equal(fromEnv.apiUrl, 'https://from-env.example.com');
      assert.equal(fromEnv.apiUrlSource, 'env');
      assert.equal(fromEnv.token, 'token-from-env');
      assert.equal(fromEnv.tokenSource, 'env');

      const fromFlag = resolveRuntimeConfig(
        {
          configPath,
          apiUrl: 'https://from-flag.example.com/',
          token: 'token-from-flag',
        },
        {
          VIBEMOCK_API_URL: 'https://from-env.example.com',
          VIBEMOCK_TOKEN: 'token-from-env',
        },
      );
      assert.equal(fromFlag.apiUrl, 'https://from-flag.example.com');
      assert.equal(fromFlag.apiUrlSource, 'flag');
      assert.equal(fromFlag.token, 'token-from-flag');
      assert.equal(fromFlag.tokenSource, 'flag');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('masks secrets safely', () => {
    assert.equal(maskSecret(undefined), null);
    assert.equal(maskSecret('short'), 'sh******');
    assert.equal(maskSecret('vmk_inspect_1234567890abcd'), 'vmk_insp...abcd');
  });

  it('discovers .vibemock.json upward, overrides global defaults, and ignores any token in project file', () => {
    const tmpRoot = makeTempDir();
    try {
      const globalConfig = path.join(tmpRoot, 'global.json');
      updateConfigValues(
        {
          token: 'global-secret-token',
          default_app: 'global-app',
          default_env: 'global-env',
          callback_url: 'http://localhost:3000/global',
        },
        globalConfig,
      );

      const repoRoot = path.join(tmpRoot, 'repo-a');
      const nestedDir = path.join(repoRoot, 'apps', 'api');
      fs.mkdirSync(nestedDir, { recursive: true });

      const projectFile = path.join(repoRoot, PROJECT_CONFIG_FILENAME);
      writeProjectConfigFile(
        {
          app: 'proj-a',
          env: 'dev-a',
          callback_url: 'http://localhost:4001/webhook',
        },
        projectFile,
      );
      // Even if someone manually puts a token in .vibemock.json, it must be ignored
      const raw = JSON.parse(fs.readFileSync(projectFile, 'utf8')) as Record<string, unknown>;
      raw.token = 'should-be-ignored';
      fs.writeFileSync(projectFile, JSON.stringify(raw));

      assert.equal(findProjectConfigPath(nestedDir), projectFile);

      const resolved = resolveRuntimeConfig({ configPath: globalConfig, cwd: nestedDir }, {});
      assert.equal(resolved.projectConfigPath, projectFile);
      assert.equal(resolved.defaultApp, 'proj-a');
      assert.equal(resolved.defaultAppSource, 'project');
      assert.equal(resolved.defaultEnv, 'dev-a');
      assert.equal(resolved.defaultEnvSource, 'project');
      assert.equal(resolved.callbackUrl, 'http://localhost:4001/webhook');
      assert.equal(resolved.callbackUrlSource, 'project');
      assert.equal(resolved.token, 'global-secret-token');
      assert.equal(resolved.tokenSource, 'config');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
