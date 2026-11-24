import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { VibeMockApiError, VibeMockClient } from './client.js';
import {
  CONFIG_KEYS,
  type ConfigKey,
  DEFAULT_API_URL,
  PROJECT_CONFIG_FILENAME,
  isConfigKey,
  maskSecret,
  resolveRuntimeConfig,
  updateConfigValues,
  writeProjectConfigFile,
} from './config.js';
import { LOCAL_CLI_CALLBACK_URL, forwardLocalCallbacks } from './forward.js';
import { runMcpServer } from './mcp.js';
import { type CliIO, defaultIO, formatTable, printJson } from './output.js';
import {
  AGENT_TARGETS,
  type SkillScope,
  installSkill,
  listSkillTargets,
  readBundledSkillContent,
  uninstallSkill,
} from './skill.js';
import { waitForRecord } from './wait.js';

function readCliVersion(): string {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const raw = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (
        parsed.name === '@vibemock/cli' &&
        typeof parsed.version === 'string' &&
        parsed.version.length > 0
      ) {
        return parsed.version;
      }
    } catch {
      // Try next relative candidate
    }
  }
  return '1.2.0';
}

export const CLI_VERSION = readCliVersion();

export interface RunCliDeps {
  io?: CliIO;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const HELP_TEXT = `VibeMock CLI v${CLI_VERSION}

Usage:
  vibemock <command> [subcommand] [options]

Config (stored in ~/.config/vibemock/config.json; default api_url: ${DEFAULT_API_URL}):
  vibemock config path
  vibemock config show
  vibemock config get <api_url|token|default_app|default_env> [--raw]
  vibemock config set <key> <value>
  vibemock config set [--api-url <url>] [--token <token>] [--default-app <app>] [--default-env <env>] [--callback-url <url>]
  vibemock config unset <api_url|token|default_app|default_env|callback_url>

Inspection & Mock Control:
  vibemock init [--app <appid>] [--env <env>] [--callback-url <local-url>] [--template <template_id>] [--force]
  vibemock whoami
  vibemock templates list
  vibemock apps list
  vibemock apps get <appid>
  vibemock apps create <appid> --name <name> [--description <text>] [--file <json-file>]
  vibemock apps create-from-template <template_id> --app <appid> [--name <name>]
  vibemock apps update <appid> --file <json-file>
  vibemock apps patch-routes <appid> --file <json-file>
  vibemock apps delete <appid>
  vibemock env list [--app <appid>]
  vibemock env get --app <appid> --env <env>
  vibemock env set --app <appid> --env <env> [--scenario <name>] [--callback-url <url|null>]
                   [--sync-delay <ms>] [--callback-delay <ms>] [--retry <0-3>] [--overrides-file <json>]
  vibemock mock-url list [--app <appid>] [--env <env>]
  vibemock mock-url create --app <appid> --env <env> --purpose <text> [--owner <name>] [--ttl <seconds>]
  vibemock mock-url revoke <id>
  vibemock records list [--app <appid>] [--env <env>] [--biz-key <key>] [--callback-status <status>] [--limit <n>]
  vibemock records get <trace_id> [--consume]
  vibemock records clear --app <appid> --env <env> [--biz-key <key>]
  vibemock wait [--app <appid>] [--env <env>] [--biz-key <key>] [--trace-id <id>]
                [--timeout <ms>] [--interval <ms>] [--consume]
  vibemock forward [--app <appid>] [--env <env>] [--to <local-url>] [--once] [--timeout <ms>] [--interval <ms>] [--no-setup]
  vibemock trigger [--app <appid>] [--env <env>] [--event <name>] [--biz-key <key>] [--payload <json> | --file <json-file>]
                   [--to <local-url>] [--callback-url <url>] [--sign-algo <algo>] [--sign-header <name>]
  vibemock domains list
  vibemock domains add <host_pattern>
  vibemock domains verify <id> --method <http_well_known|webhook_challenge|dns_txt> [--url <challenge_url>]
  vibemock domains remove <id>

Agent Skill Installation:
  vibemock skill list
  vibemock skill install [--agent <${AGENT_TARGETS.join('|')}|all|auto>] [--scope <project|user>]
                         [--dir <custom-dir>] [--force] [--dry-run]
  vibemock skill uninstall [--agent <${AGENT_TARGETS.join('|')}|all|auto>] [--scope <project|user>]
                           [--dir <custom-dir>] [--dry-run]
  vibemock skill print

MCP Server (for Cursor / Claude Code / Antigravity):
  vibemock mcp        Start stdio JSON-RPC MCP server

Global Options:
  --api-url <url>     Override VibeMock API URL (default: ${DEFAULT_API_URL})
  --token <token>     Override Inspect/Admin API Bearer token
  --config <path>     Override config file path
  --json              Output raw JSON (recommended for Coding Agents)
  -h, --help          Show help
  -v, --version       Show version`;

function parseIntOption(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const num = Number(raw);
  if (!Number.isInteger(num)) {
    throw new Error(`Option --${name} must be an integer, got "${raw}".`);
  }
  return num;
}

function readJsonFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse JSON file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function sanitizeDefaultAppId(dirName: string): string {
  const cleaned = dirName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20);
  return cleaned || 'my-app';
}

function parseScope(raw: string | undefined): SkillScope {
  if (!raw || raw === 'project') return 'project';
  if (raw === 'user') return 'user';
  throw new Error(`Invalid --scope "${raw}". Expected "project" or "user".`);
}

function requireAppEnv(
  app: string | undefined,
  envName: string | undefined,
): { appid: string; env: string } {
  if (!app) {
    throw new Error('Missing --app <appid> (or set default_app via `vibemock config set`).');
  }
  if (!envName) {
    throw new Error('Missing --env <env> (or set default_env via `vibemock config set`).');
  }
  return { appid: app, env: envName };
}

export async function runCli(argv: string[], deps: RunCliDeps = {}): Promise<number> {
  const io = deps.io ?? defaultIO;
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home;

  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
        json: { type: 'boolean', default: false },
        raw: { type: 'boolean', default: false },
        'api-url': { type: 'string' },
        token: { type: 'string' },
        config: { type: 'string' },
        'default-app': { type: 'string' },
        'default-env': { type: 'string' },
        app: { type: 'string' },
        env: { type: 'string' },
        scenario: { type: 'string' },
        'callback-url': { type: 'string' },
        'sync-delay': { type: 'string' },
        'callback-delay': { type: 'string' },
        retry: { type: 'string' },
        'overrides-file': { type: 'string' },
        file: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        purpose: { type: 'string' },
        owner: { type: 'string' },
        ttl: { type: 'string' },
        'biz-key': { type: 'string' },
        'trace-id': { type: 'string' },
        'callback-status': { type: 'string' },
        limit: { type: 'string' },
        consume: { type: 'boolean', default: false },
        timeout: { type: 'string' },
        interval: { type: 'string' },
        to: { type: 'string' },
        once: { type: 'boolean', default: false },
        'no-setup': { type: 'boolean', default: false },
        template: { type: 'string' },
        event: { type: 'string' },
        payload: { type: 'string' },
        'sign-algo': { type: 'string' },
        'sign-header': { type: 'string' },
        method: { type: 'string' },
        url: { type: 'string' },
        agent: { type: 'string' },
        scope: { type: 'string' },
        dir: { type: 'string' },
        force: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
      },
    });

    const opts = parsed.values;
    const [cmd, subcmd, arg1, arg2] = parsed.positionals;

    if (opts.version) {
      if (opts.json) {
        printJson({ version: CLI_VERSION }, io);
      } else {
        io.stdout(CLI_VERSION);
      }
      return 0;
    }

    if (opts.help || !cmd || cmd === 'help') {
      io.stdout(HELP_TEXT);
      return 0;
    }

    if (cmd === 'mcp') {
      await runMcpServer({
        version: CLI_VERSION,
        env,
        cwd,
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
      });
      return 0;
    }

    const runtimeConfig = resolveRuntimeConfig(
      {
        apiUrl: opts['api-url'],
        token: opts.token,
        callbackUrl: opts.to ?? opts['callback-url'],
        configPath: opts.config,
        cwd,
      },
      env,
    );

    const resolveApp = () => opts.app ?? runtimeConfig.defaultApp;
    const resolveEnv = () => opts.env ?? runtimeConfig.defaultEnv;

    const createClient = () =>
      new VibeMockClient({
        apiUrl: runtimeConfig.apiUrl,
        token: runtimeConfig.token,
        fetchImpl: deps.fetchImpl,
      });

    // 1. config commands
    if (cmd === 'config') {
      if (!subcmd || subcmd === 'show') {
        const data = {
          config_path: runtimeConfig.configPath,
          project_config_path: runtimeConfig.projectConfigPath,
          api_url: runtimeConfig.apiUrl,
          api_url_source: runtimeConfig.apiUrlSource,
          token: maskSecret(runtimeConfig.token),
          token_configured: Boolean(runtimeConfig.token),
          token_source: runtimeConfig.tokenSource,
          default_app: runtimeConfig.defaultApp ?? null,
          default_app_source: runtimeConfig.defaultAppSource,
          default_env: runtimeConfig.defaultEnv ?? null,
          default_env_source: runtimeConfig.defaultEnvSource,
          callback_url: runtimeConfig.callbackUrl ?? null,
          callback_url_source: runtimeConfig.callbackUrlSource,
        };
        if (opts.json) {
          printJson(data, io);
        } else {
          io.stdout(
            formatTable(
              ['KEY', 'VALUE', 'SOURCE'],
              [
                ['config_path', runtimeConfig.configPath, 'file'],
                ['project_config_path', runtimeConfig.projectConfigPath ?? '(not set)', 'project'],
                ['api_url', runtimeConfig.apiUrl, runtimeConfig.apiUrlSource],
                [
                  'token',
                  maskSecret(runtimeConfig.token) ?? '(not set)',
                  runtimeConfig.tokenSource,
                ],
                [
                  'default_app',
                  runtimeConfig.defaultApp ?? '(not set)',
                  runtimeConfig.defaultAppSource,
                ],
                [
                  'default_env',
                  runtimeConfig.defaultEnv ?? '(not set)',
                  runtimeConfig.defaultEnvSource,
                ],
                [
                  'callback_url',
                  runtimeConfig.callbackUrl ?? '(not set)',
                  runtimeConfig.callbackUrlSource,
                ],
              ],
            ),
          );
        }
        return 0;
      }

      if (subcmd === 'path') {
        if (opts.json) {
          printJson({ config_path: runtimeConfig.configPath }, io);
        } else {
          io.stdout(runtimeConfig.configPath);
        }
        return 0;
      }

      if (subcmd === 'get') {
        if (!arg1 || !isConfigKey(arg1)) {
          throw new Error(`Invalid key "${arg1 ?? ''}". Valid keys: ${CONFIG_KEYS.join(', ')}.`);
        }
        const valueMap: Record<ConfigKey, { value: string | null; source: string }> = {
          api_url: { value: runtimeConfig.apiUrl, source: runtimeConfig.apiUrlSource },
          token: {
            value: opts.raw ? (runtimeConfig.token ?? null) : maskSecret(runtimeConfig.token),
            source: runtimeConfig.tokenSource,
          },
          default_app: {
            value: runtimeConfig.defaultApp ?? null,
            source: runtimeConfig.defaultAppSource,
          },
          default_env: {
            value: runtimeConfig.defaultEnv ?? null,
            source: runtimeConfig.defaultEnvSource,
          },
          callback_url: {
            value: runtimeConfig.callbackUrl ?? null,
            source: runtimeConfig.callbackUrlSource,
          },
        };
        const entry = valueMap[arg1];
        if (opts.json) {
          printJson({ key: arg1, value: entry.value, source: entry.source }, io);
        } else {
          io.stdout(entry.value ?? '');
        }
        return 0;
      }

      if (subcmd === 'set') {
        const updates: Partial<Record<ConfigKey, string | undefined>> = {};
        if (arg1 !== undefined) {
          if (!isConfigKey(arg1)) {
            throw new Error(`Invalid key "${arg1}". Valid keys: ${CONFIG_KEYS.join(', ')}.`);
          }
          if (arg2 === undefined) {
            throw new Error(`Missing value for key "${arg1}".`);
          }
          updates[arg1] = arg2;
        }
        if (opts['api-url'] !== undefined) updates.api_url = opts['api-url'];
        if (opts.token !== undefined) updates.token = opts.token;
        if (opts['default-app'] !== undefined) updates.default_app = opts['default-app'];
        if (opts['default-env'] !== undefined) updates.default_env = opts['default-env'];
        if (opts['callback-url'] !== undefined) updates.callback_url = opts['callback-url'];

        if (Object.keys(updates).length === 0) {
          throw new Error(
            'Nothing to set. Use `vibemock config set <key> <value>` or pass --api-url / --token / --default-app / --default-env.',
          );
        }

        const saved = updateConfigValues(updates, runtimeConfig.configPath);
        const result = {
          config_path: runtimeConfig.configPath,
          updated_keys: Object.keys(updates),
          api_url: saved.api_url ?? DEFAULT_API_URL,
          token: maskSecret(saved.token),
          default_app: saved.default_app ?? null,
          default_env: saved.default_env ?? null,
        };
        if (opts.json) {
          printJson(result, io);
        } else {
          io.stdout(`Updated ${result.updated_keys.join(', ')} in ${runtimeConfig.configPath}`);
        }
        return 0;
      }

      if (subcmd === 'unset') {
        if (!arg1 || !isConfigKey(arg1)) {
          throw new Error(`Invalid key "${arg1 ?? ''}". Valid keys: ${CONFIG_KEYS.join(', ')}.`);
        }
        updateConfigValues({ [arg1]: undefined }, runtimeConfig.configPath);
        if (opts.json) {
          printJson({ config_path: runtimeConfig.configPath, unset: arg1 }, io);
        } else {
          io.stdout(`Unset ${arg1} in ${runtimeConfig.configPath}`);
        }
        return 0;
      }

      throw new Error(`Unknown config subcommand "${subcmd}".`);
    }

    // 2. skill commands
    if (cmd === 'skill') {
      if (subcmd === 'list') {
        const entries = listSkillTargets(cwd, home);
        if (opts.json) {
          printJson({ targets: entries }, io);
        } else {
          io.stdout(
            formatTable(
              ['AGENT', 'PROJECT', 'USER', 'PROJECT PATH'],
              entries.map((e) => [
                e.agent,
                e.project_installed ? 'installed' : '-',
                e.user_installed ? 'installed' : '-',
                e.project_path,
              ]),
            ),
          );
        }
        return 0;
      }

      if (subcmd === 'print') {
        const content = readBundledSkillContent();
        if (opts.json) {
          printJson({ name: 'vibemock', content }, io);
        } else {
          io.stdout(content.trimEnd());
        }
        return 0;
      }

      if (subcmd === 'install') {
        const scope = parseScope(opts.scope);
        const results = installSkill({
          agents: opts.agent,
          scope,
          customDir: opts.dir,
          force: opts.force,
          dryRun: opts['dry-run'],
          cwd,
          home,
        });
        if (opts.json) {
          printJson({ scope, dry_run: opts['dry-run'], results }, io);
        } else {
          io.stdout(
            formatTable(
              ['STATUS', 'AGENTS', 'TARGET PATH'],
              results.map((r) => [r.status, r.agents.join(','), r.target_path]),
            ),
          );
          if (results.some((r) => r.status === 'skipped')) {
            io.stderr('Some targets already exist. Re-run with --force to overwrite.');
          }
        }
        return 0;
      }

      if (subcmd === 'uninstall') {
        const scope = parseScope(opts.scope);
        const results = uninstallSkill({
          agents: opts.agent,
          scope,
          customDir: opts.dir,
          dryRun: opts['dry-run'],
          cwd,
          home,
        });
        if (opts.json) {
          printJson({ scope, dry_run: opts['dry-run'], results }, io);
        } else {
          io.stdout(
            formatTable(
              ['STATUS', 'AGENTS', 'TARGET PATH'],
              results.map((r) => [r.status, r.agents.join(','), r.target_path]),
            ),
          );
        }
        return 0;
      }

      throw new Error(`Unknown skill subcommand "${subcmd ?? ''}".`);
    }

    // 2.5 init (project-level .vibemock.json without secrets)
    if (cmd === 'init') {
      const targetPath = path.join(cwd, PROJECT_CONFIG_FILENAME);
      if (fs.existsSync(targetPath) && !opts.force) {
        throw new Error(
          `${PROJECT_CONFIG_FILENAME} already exists at ${targetPath}. Pass --force to overwrite.`,
        );
      }

      const appid = opts.app ?? sanitizeDefaultAppId(path.basename(cwd));
      const envName = opts.env ?? 'dev';
      const callbackUrl = opts.to ?? opts['callback-url'];
      const saved = writeProjectConfigFile(
        {
          app: appid,
          env: envName,
          ...(callbackUrl ? { callback_url: callbackUrl } : {}),
          ...(opts['api-url'] ? { api_url: opts['api-url'] } : {}),
        },
        targetPath,
      );

      let provisionedApp: unknown;
      let configuredEnv: unknown;
      if (runtimeConfig.token) {
        const client = createClient();
        if (opts.template) {
          try {
            provisionedApp = await client.request('/_inspect/apps/from-template', {
              method: 'POST',
              body: { template_id: opts.template, appid },
            });
          } catch (err) {
            if (!(err instanceof VibeMockApiError && err.status === 409)) {
              throw err;
            }
          }
        }
        if (callbackUrl) {
          let existingEnv: Record<string, unknown> | undefined;
          try {
            const res = await client.request<{ env_config: Record<string, unknown> }>(
              `/_inspect/env-configs/${encodeURIComponent(appid)}/${encodeURIComponent(envName)}`,
            );
            existingEnv = res.env_config;
          } catch (err) {
            if (!(err instanceof VibeMockApiError && err.status === 404)) {
              throw err;
            }
          }
          configuredEnv = await client.request(
            `/_inspect/env-configs/${encodeURIComponent(appid)}/${encodeURIComponent(envName)}`,
            {
              method: 'PUT',
              body: {
                scenario: (existingEnv?.scenario as string | undefined) ?? 'success',
                sync_delay_ms: (existingEnv?.sync_delay_ms as number | undefined) ?? 0,
                callback_delay_ms: (existingEnv?.callback_delay_ms as number | undefined) ?? 0,
                retry_count: (existingEnv?.retry_count as number | undefined) ?? 0,
                default_callback_url: LOCAL_CLI_CALLBACK_URL,
              },
            },
          );
        }
      }

      const result = {
        project_config_path: targetPath,
        config: saved,
        ...(provisionedApp ? { app: provisionedApp } : {}),
        ...(configuredEnv ? { env_config: configuredEnv } : {}),
      };
      if (opts.json) {
        printJson(result, io);
      } else {
        io.stdout(
          `Initialized ${targetPath} (app=${saved.app}, env=${saved.env}${saved.callback_url ? `, callback_url=${saved.callback_url}` : ''})`,
        );
      }
      return 0;
    }

    // 3. whoami
    if (cmd === 'whoami') {
      const data = await createClient().request<{
        principal: {
          role: string;
          email: string;
          name: string;
          authMethod: string;
          scopes: string[];
          allowedApps: string[] | null;
          allowedEnvs: string[] | null;
        };
      }>('/_inspect/me');
      if (opts.json) {
        printJson(data, io);
      } else {
        const p = data.principal;
        io.stdout(
          formatTable(
            ['FIELD', 'VALUE'],
            [
              ['api_url', runtimeConfig.apiUrl],
              ['name', p.name],
              ['email', p.email],
              ['role', p.role],
              ['auth_method', p.authMethod],
              ['scopes', p.scopes.join(', ')],
              ['allowed_apps', p.allowedApps ? p.allowedApps.join(', ') : '*'],
              ['allowed_envs', p.allowedEnvs ? p.allowedEnvs.join(', ') : '*'],
            ],
          ),
        );
      }
      return 0;
    }

    // 3.5 templates
    if (cmd === 'templates') {
      if (!subcmd || subcmd === 'list') {
        const data = await createClient().request<{
          templates: Array<{ id: string; name: string; category: string; summary: string }>;
        }>('/_inspect/templates');
        if (opts.json) {
          printJson(data, io);
        } else {
          io.stdout(
            formatTable(
              ['TEMPLATE ID', 'CATEGORY', 'NAME'],
              data.templates.map((t) => [t.id, t.category, t.name]),
            ),
          );
        }
        return 0;
      }
      throw new Error(`Unknown templates subcommand "${subcmd}".`);
    }

    // 4. apps commands
    if (cmd === 'apps') {
      const client = createClient();
      if (!subcmd || subcmd === 'list') {
        const data = await client.request<{
          apps: Array<{ appid: string; name: string; description: string }>;
        }>('/_inspect/apps');
        if (opts.json) {
          printJson(data, io);
        } else if (data.apps.length === 0) {
          io.stdout('No enabled apps found.');
        } else {
          io.stdout(
            formatTable(
              ['APPID', 'NAME', 'DESCRIPTION'],
              data.apps.map((a) => [a.appid, a.name, a.description ?? '']),
            ),
          );
        }
        return 0;
      }

      if (subcmd === 'get') {
        const appid = arg1 ?? resolveApp();
        if (!appid) throw new Error('Missing <appid>.');
        const data = await client.request(`/_inspect/apps/${encodeURIComponent(appid)}`);
        printJson(data, io);
        return 0;
      }

      if (subcmd === 'create') {
        const fileBody = opts.file ? (readJsonFile(opts.file) as Record<string, unknown>) : {};
        const appid =
          arg1 ??
          opts.app ??
          (typeof fileBody.appid === 'string' ? fileBody.appid : undefined) ??
          resolveApp();
        if (!appid) throw new Error('Missing <appid>.');
        const name =
          opts.name ?? (typeof fileBody.name === 'string' ? fileBody.name : undefined) ?? appid;
        const description =
          opts.description ??
          (typeof fileBody.description === 'string' ? fileBody.description : undefined) ??
          '';
        const payload = {
          ...fileBody,
          appid,
          name,
          description,
        };
        const data = await client.request('/_inspect/apps', {
          method: 'POST',
          body: payload,
        });
        printJson(data, io);
        return 0;
      }

      if (subcmd === 'update') {
        const appid = arg1 ?? resolveApp();
        if (!appid) throw new Error('Missing <appid>.');
        if (!opts.file) throw new Error('Missing --file <json-file>.');
        const body = readJsonFile(opts.file);
        const data = await client.request(`/_inspect/apps/${encodeURIComponent(appid)}`, {
          method: 'PUT',
          body,
        });
        printJson(data, io);
        return 0;
      }

      if (subcmd === 'patch-routes') {
        const appid = arg1 ?? resolveApp();
        if (!appid) throw new Error('Missing <appid>.');
        if (!opts.file) throw new Error('Missing --file <json-file>.');
        const body = readJsonFile(opts.file);
        const data = await client.request(`/_inspect/apps/${encodeURIComponent(appid)}/routes`, {
          method: 'PATCH',
          body,
        });
        printJson(data, io);
        return 0;
      }

      if (subcmd === 'create-from-template') {
        if (!arg1) throw new Error('Missing <template_id>. Run `vibemock templates list`.');
        const appid = opts.app ?? arg2;
        if (!appid) throw new Error('Missing --app <appid>.');
        const data = await client.request('/_inspect/apps/from-template', {
          method: 'POST',
          body: {
            template_id: arg1,
            appid,
            ...(opts.name ? { name: opts.name } : {}),
          },
        });
        printJson(data, io);
        return 0;
      }

      if (subcmd === 'delete') {
        const appid = arg1 ?? resolveApp();
        if (!appid) throw new Error('Missing <appid>.');
        const data = await client.request(`/_inspect/apps/${encodeURIComponent(appid)}`, {
          method: 'DELETE',
        });
        printJson(data, io);
        return 0;
      }

      throw new Error(`Unknown apps subcommand "${subcmd}".`);
    }

    // 5. env commands
    if (cmd === 'env') {
      const client = createClient();
      if (!subcmd || subcmd === 'list') {
        const data = await client.request<{
          env_configs: Array<{
            appid: string;
            env: string;
            scenario: string;
            is_protected: number;
            default_callback_url: string | null;
            owner_email: string;
          }>;
        }>('/_inspect/env-configs', {
          query: { appid: opts.app },
        });
        if (opts.json) {
          printJson(data, io);
        } else if (data.env_configs.length === 0) {
          io.stdout('No env configs found.');
        } else {
          io.stdout(
            formatTable(
              ['APPID', 'ENV', 'SCENARIO', 'PROTECTED', 'CALLBACK URL'],
              data.env_configs.map((e) => [
                e.appid,
                e.env,
                e.scenario,
                e.is_protected ? 'yes' : 'no',
                e.default_callback_url ?? '-',
              ]),
            ),
          );
        }
        return 0;
      }

      if (subcmd === 'get') {
        const { appid, env: envName } = requireAppEnv(resolveApp(), resolveEnv());
        const data = await client.request(
          `/_inspect/env-configs/${encodeURIComponent(appid)}/${encodeURIComponent(envName)}`,
        );
        printJson(data, io);
        return 0;
      }

      if (subcmd === 'set') {
        const { appid, env: envName } = requireAppEnv(resolveApp(), resolveEnv());
        let existing: Record<string, unknown> | undefined;
        try {
          const res = await client.request<{ env_config: Record<string, unknown> }>(
            `/_inspect/env-configs/${encodeURIComponent(appid)}/${encodeURIComponent(envName)}`,
          );
          existing = res.env_config;
        } catch (err) {
          if (!(err instanceof VibeMockApiError && err.status === 404)) {
            throw err;
          }
        }

        const payload: Record<string, unknown> = {
          scenario: opts.scenario ?? (existing?.scenario as string | undefined) ?? 'success',
          sync_delay_ms:
            parseIntOption(opts['sync-delay'], 'sync-delay') ??
            (existing?.sync_delay_ms as number | undefined) ??
            0,
          callback_delay_ms:
            parseIntOption(opts['callback-delay'], 'callback-delay') ??
            (existing?.callback_delay_ms as number | undefined) ??
            1000,
          retry_count:
            parseIntOption(opts.retry, 'retry') ??
            (existing?.retry_count as number | undefined) ??
            0,
        };

        if (opts['callback-url'] !== undefined) {
          const rawUrl = opts['callback-url'].trim();
          payload.default_callback_url =
            rawUrl === '' || rawUrl.toLowerCase() === 'null' ? null : rawUrl;
        } else if (existing?.default_callback_url !== undefined) {
          payload.default_callback_url = existing.default_callback_url;
        }

        if (opts['overrides-file']) {
          payload.overrides = readJsonFile(opts['overrides-file']);
        }

        const data = await client.request(
          `/_inspect/env-configs/${encodeURIComponent(appid)}/${encodeURIComponent(envName)}`,
          {
            method: 'PUT',
            body: payload,
          },
        );
        printJson(data, io);
        return 0;
      }

      throw new Error(`Unknown env subcommand "${subcmd}".`);
    }

    // 6. mock-url commands
    if (cmd === 'mock-url') {
      const client = createClient();
      if (!subcmd || subcmd === 'list') {
        const data = await client.request<{
          tokens: Array<{
            id: string;
            appid: string;
            env: string;
            token_masked: string;
            status: string;
            expires_at: string;
          }>;
        }>('/_inspect/mock-url-tokens', {
          query: { appid: opts.app, env: opts.env },
        });
        if (opts.json) {
          printJson(data, io);
        } else if (data.tokens.length === 0) {
          io.stdout('No mock URL tokens found.');
        } else {
          io.stdout(
            formatTable(
              ['ID', 'APPID', 'ENV', 'STATUS', 'EXPIRES AT'],
              data.tokens.map((t) => [t.id, t.appid, t.env, t.status, t.expires_at]),
            ),
          );
        }
        return 0;
      }

      if (subcmd === 'create') {
        const { appid, env: envName } = requireAppEnv(resolveApp(), resolveEnv());
        const purpose = opts.purpose?.trim() || 'CLI self-test';
        const ttl = parseIntOption(opts.ttl, 'ttl') ?? 7200;
        const data = await client.request<{
          base_url: string;
          token_record: { id: string; expires_at: string };
        }>('/_inspect/mock-url-tokens', {
          method: 'POST',
          body: {
            appid,
            env: envName,
            purpose,
            ...(opts.owner ? { owner: opts.owner } : {}),
            ttl_seconds: ttl,
          },
        });
        if (opts.json) {
          printJson(data, io);
        } else {
          io.stdout(
            formatTable(
              ['FIELD', 'VALUE'],
              [
                ['id', data.token_record.id],
                ['base_url', data.base_url],
                ['expires_at', data.token_record.expires_at],
              ],
            ),
          );
        }
        return 0;
      }

      if (subcmd === 'revoke') {
        if (!arg1) throw new Error('Missing token <id>.');
        const data = await client.request(`/_inspect/mock-url-tokens/${encodeURIComponent(arg1)}`, {
          method: 'DELETE',
        });
        printJson(data, io);
        return 0;
      }

      throw new Error(`Unknown mock-url subcommand "${subcmd}".`);
    }

    // 7. records commands
    if (cmd === 'records') {
      const client = createClient();
      if (!subcmd || subcmd === 'list') {
        const limit = parseIntOption(opts.limit, 'limit');
        const data = await client.request<{
          records: Array<{
            trace_id: string;
            appid: string;
            env: string;
            biz_key: string | null;
            inbound_method?: string;
            inbound_path?: string;
            method?: string;
            path?: string;
            sync_status: number;
            callback_status: string;
            created_at: string;
          }>;
        }>('/_inspect/records', {
          query: {
            appid: opts.app,
            env: opts.env,
            biz_key: opts['biz-key'],
            callback_status: opts['callback-status'],
            limit,
          },
        });
        if (opts.json) {
          printJson(data, io);
        } else if (data.records.length === 0) {
          io.stdout('No records found.');
        } else {
          io.stdout(
            formatTable(
              ['TRACE ID', 'APP/ENV', 'BIZ KEY', 'REQ', 'SYNC', 'CALLBACK'],
              data.records.map((r) => [
                r.trace_id,
                `${r.appid}/${r.env}`,
                r.biz_key ?? '-',
                `${r.inbound_method ?? r.method ?? '-'} ${r.inbound_path ?? r.path ?? '-'}`,
                String(r.sync_status),
                r.callback_status,
              ]),
            ),
          );
        }
        return 0;
      }

      if (subcmd === 'get') {
        if (!arg1) throw new Error('Missing <trace_id>.');
        const data = await client.request(`/_inspect/records/${encodeURIComponent(arg1)}`, {
          query: opts.consume ? { consume: true } : undefined,
        });
        printJson(data, io);
        return 0;
      }

      if (subcmd === 'clear') {
        const { appid, env: envName } = requireAppEnv(resolveApp(), resolveEnv());
        const data = await client.request('/_inspect/records', {
          method: 'DELETE',
          query: {
            appid,
            env: envName,
            biz_key: opts['biz-key'],
          },
        });
        printJson(data, io);
        return 0;
      }

      throw new Error(`Unknown records subcommand "${subcmd}".`);
    }

    // 8. wait command
    if (cmd === 'wait') {
      const traceId = opts['trace-id'] ?? subcmd;
      const appid = resolveApp();
      const envName = resolveEnv();
      if (!traceId && (!appid || !envName)) {
        throw new Error(
          'Provide --trace-id <id> or both --app <appid> and --env <env> (with optional --biz-key <key>).',
        );
      }
      const timeoutMs = parseIntOption(opts.timeout, 'timeout') ?? 15_000;
      const intervalMs = parseIntOption(opts.interval, 'interval') ?? 500;
      const result = await waitForRecord(createClient(), {
        traceId,
        appid,
        env: envName,
        bizKey: opts['biz-key'],
        timeoutMs,
        intervalMs,
        consume: opts.consume,
        sleep: deps.sleep,
      });
      printJson(result, io);
      return 0;
    }

    // 9. forward command (local://cli pull-and-forward without domain verification)
    if (cmd === 'forward') {
      const { appid, env: envName } = requireAppEnv(resolveApp(), resolveEnv());
      const targetUrl = opts.to ?? runtimeConfig.callbackUrl;
      if (!targetUrl) {
        throw new Error(
          'Missing target callback URL. Pass --to <http://localhost:...> or run `vibemock config set --callback-url <url>`.',
        );
      }

      const client = createClient();
      if (!opts['no-setup']) {
        let existing: Record<string, unknown> | undefined;
        try {
          const res = await client.request<{ env_config: Record<string, unknown> }>(
            `/_inspect/env-configs/${encodeURIComponent(appid)}/${encodeURIComponent(envName)}`,
          );
          existing = res.env_config;
        } catch (err) {
          if (!(err instanceof VibeMockApiError && err.status === 404)) {
            throw err;
          }
        }
        await client.request(
          `/_inspect/env-configs/${encodeURIComponent(appid)}/${encodeURIComponent(envName)}`,
          {
            method: 'PUT',
            body: {
              scenario: (existing?.scenario as string | undefined) ?? 'success',
              sync_delay_ms: (existing?.sync_delay_ms as number | undefined) ?? 0,
              callback_delay_ms: (existing?.callback_delay_ms as number | undefined) ?? 0,
              retry_count: (existing?.retry_count as number | undefined) ?? 0,
              default_callback_url: LOCAL_CLI_CALLBACK_URL,
            },
          },
        );
      }

      const timeoutMs = parseIntOption(opts.timeout, 'timeout') ?? 15_000;
      const intervalMs = parseIntOption(opts.interval, 'interval') ?? 500;
      const forwarded = await forwardLocalCallbacks(client, {
        appid,
        env: envName,
        targetUrl,
        once: opts.once,
        timeoutMs,
        intervalMs,
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
        onForwarded: (item) => {
          if (!opts.json) {
            io.stdout(
              `[${item.status.toUpperCase()}] ${item.trace_id} -> ${item.target_url} (HTTP ${item.http_status ?? 'ERR'}, ${item.duration_ms}ms)`,
            );
          }
        },
      });
      if (opts.json) {
        printJson({ appid, env: envName, target_url: targetUrl, forwarded }, io);
      }
      return 0;
    }

    // 9.5 trigger command (standalone inbound-only webhook trigger + optional immediate local forward)
    if (cmd === 'trigger') {
      const { appid, env: envName } = requireAppEnv(resolveApp(), resolveEnv());
      let payload: unknown;
      if (opts.file) {
        payload = readJsonFile(opts.file);
      } else if (opts.payload !== undefined) {
        try {
          payload = JSON.parse(opts.payload);
        } catch {
          payload = opts.payload;
        }
      } else {
        payload = {
          event: opts.event ?? 'mock.trigger',
          ...(opts['biz-key'] ? { biz_key: opts['biz-key'] } : {}),
          triggered_at: new Date().toISOString(),
        };
      }

      const explicitCloudUrl =
        opts['callback-url'] && opts['callback-url'] !== LOCAL_CLI_CALLBACK_URL
          ? opts['callback-url']
          : undefined;
      const localTargetUrl = opts.to ?? runtimeConfig.callbackUrl;

      const client = createClient();
      const triggered = await client.request<{
        trace_id: string;
        appid: string;
        env: string;
        biz_key: string | null;
        callback_status: string;
        callback_url: string;
        is_local_forward: boolean;
      }>('/_inspect/trigger', {
        method: 'POST',
        body: {
          appid,
          env: envName,
          payload,
          ...(opts.event ? { event: opts.event } : {}),
          ...(opts['biz-key'] ? { biz_key: opts['biz-key'] } : {}),
          callback_url: explicitCloudUrl ?? LOCAL_CLI_CALLBACK_URL,
          ...(opts['sign-algo'] ? { sign_algo: opts['sign-algo'] } : {}),
          ...(opts['sign-header'] ? { sign_header: opts['sign-header'] } : {}),
        },
      });

      let forwarded: unknown;
      if (!explicitCloudUrl && localTargetUrl) {
        const timeoutMs = parseIntOption(opts.timeout, 'timeout') ?? 15_000;
        const intervalMs = parseIntOption(opts.interval, 'interval') ?? 200;
        forwarded = await forwardLocalCallbacks(client, {
          appid,
          env: envName,
          targetUrl: localTargetUrl,
          once: true,
          timeoutMs,
          intervalMs,
          fetchImpl: deps.fetchImpl,
          sleep: deps.sleep,
          onForwarded: (item) => {
            if (!opts.json) {
              io.stdout(
                `[${item.status.toUpperCase()}] ${item.trace_id} -> ${item.target_url} (HTTP ${item.http_status ?? 'ERR'}, ${item.duration_ms}ms)`,
              );
            }
          },
        });
      }

      if (opts.json) {
        printJson({ triggered, ...(forwarded ? { forwarded } : {}) }, io);
      } else if (!forwarded) {
        io.stdout(
          `Triggered ${triggered.trace_id} on ${triggered.appid}/${triggered.env} -> ${triggered.callback_url} (${triggered.callback_status})`,
        );
      }
      return 0;
    }

    // 10. domains commands (cloud callback domain ownership verification)
    if (cmd === 'domains') {
      const client = createClient();
      if (!subcmd || subcmd === 'list') {
        const data = await client.request<{
          domains: Array<{
            id: string;
            host_pattern: string;
            status: string;
            verify_method: string | null;
            expires_at: string | null;
          }>;
        }>('/_inspect/domains');
        if (opts.json) {
          printJson(data, io);
        } else if (data.domains.length === 0) {
          io.stdout('No callback domains configured.');
        } else {
          io.stdout(
            formatTable(
              ['ID', 'HOST PATTERN', 'STATUS', 'METHOD', 'EXPIRES AT'],
              data.domains.map((d) => [
                d.id,
                d.host_pattern,
                d.status,
                d.verify_method ?? '-',
                d.expires_at ?? '-',
              ]),
            ),
          );
        }
        return 0;
      }

      if (subcmd === 'add') {
        if (!arg1) throw new Error('Missing <host_pattern> (e.g. staging.example.com).');
        const data = await client.request('/_inspect/domains', {
          method: 'POST',
          body: { host_pattern: arg1 },
        });
        printJson(data, io);
        return 0;
      }

      if (subcmd === 'verify') {
        if (!arg1) throw new Error('Missing domain <id>.');
        const method = opts.method ?? 'http_well_known';
        const data = await client.request(`/_inspect/domains/${encodeURIComponent(arg1)}/verify`, {
          method: 'POST',
          body: {
            method,
            ...(opts.url ? { challenge_url: opts.url } : {}),
          },
        });
        printJson(data, io);
        return 0;
      }

      if (subcmd === 'remove' || subcmd === 'delete') {
        if (!arg1) throw new Error('Missing domain <id>.');
        const data = await client.request(`/_inspect/domains/${encodeURIComponent(arg1)}`, {
          method: 'DELETE',
        });
        printJson(data, io);
        return 0;
      }

      throw new Error(`Unknown domains subcommand "${subcmd}".`);
    }

    throw new Error(`Unknown command "${cmd}". Run \`vibemock --help\` for usage.`);
  } catch (err) {
    if (err instanceof VibeMockApiError) {
      if (argv.includes('--json')) {
        printJson(
          {
            error: {
              status: err.status,
              code: err.code,
              message: err.message,
              ...(err.details !== undefined ? { details: err.details } : {}),
            },
          },
          io,
        );
      } else {
        io.stderr(`API Error (${err.status} ${err.code}): ${err.message}`);
      }
      return 1;
    }

    const message = err instanceof Error ? err.message : String(err);
    if (argv.includes('--json')) {
      printJson({ error: { code: 'CLI_ERROR', message } }, io);
    } else {
      io.stderr(`Error: ${message}`);
    }
    return 1;
  }
}
