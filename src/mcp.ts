import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { VibeMockApiError, VibeMockClient } from './client.js';
import { PROJECT_CONFIG_FILENAME, resolveRuntimeConfig, writeProjectConfigFile } from './config.js';
import { LOCAL_CLI_CALLBACK_URL, forwardLocalCallbacks } from './forward.js';
import { waitForRecord } from './wait.js';

export interface McpServerDeps {
  version: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'vibemock_whoami',
    description:
      'Inspect the current authenticated VibeMock identity, plan quotas, and daily usage.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'vibemock_templates_list',
    description:
      'List built-in official vendor templates (Stripe, Creem, Lemon Squeezy, GitHub, Clerk).',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'vibemock_init_project',
    description:
      'Initialize a project-scoped .vibemock.json file (never stores tokens) and optionally bootstrap an app from a vendor template and configure local://cli forwarding.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App ID (1-20 chars [a-z0-9-], no "--")' },
        env: { type: 'string', description: 'Environment name (default: "dev")' },
        callback_url: {
          type: 'string',
          description: 'Local callback URL for forwarding (e.g. http://localhost:3000/api/webhook)',
        },
        template: {
          type: 'string',
          description: 'Optional vendor template ID to provision (e.g. stripe-checkout)',
        },
        force: { type: 'boolean', description: 'Overwrite existing .vibemock.json' },
        cwd: { type: 'string', description: 'Project root directory (defaults to current cwd)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'vibemock_apps_create_from_template',
    description: 'Create a new VibeMock app from an official vendor template.',
    inputSchema: {
      type: 'object',
      properties: {
        template_id: { type: 'string', description: 'Vendor template ID (e.g. stripe-checkout)' },
        appid: { type: 'string', description: 'Unique App ID (1-20 chars [a-z0-9-])' },
        name: { type: 'string', description: 'Optional display name' },
      },
      required: ['template_id', 'appid'],
      additionalProperties: false,
    },
  },
  {
    name: 'vibemock_env_set',
    description:
      'Configure scenario, callback_url (use "local://cli" for tunnel-free localhost forwarding), delays, or retry count for an (appid, env).',
    inputSchema: {
      type: 'object',
      properties: {
        appid: { type: 'string', description: 'App ID (defaults to .vibemock.json / global)' },
        env: { type: 'string', description: 'Env name (defaults to .vibemock.json / global)' },
        scenario: {
          type: 'string',
          description: 'Scenario name (success, sync_fail, async_fail, callback_drop, retry, ...)',
        },
        callback_url: {
          type: 'string',
          description: 'Use "local://cli" for local forwarding, verified https:// URL, or null',
        },
        sync_delay_ms: { type: 'integer', minimum: 0, maximum: 15000 },
        callback_delay_ms: { type: 'integer', minimum: 0, maximum: 15000 },
        retry_count: { type: 'integer', minimum: 0, maximum: 3 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'vibemock_mock_url_create',
    description:
      'Issue a short-lived Mock BASE_URL (https://{env}--{appid}--{token}.vibemock.bid) that requires zero custom auth headers.',
    inputSchema: {
      type: 'object',
      properties: {
        appid: { type: 'string', description: 'App ID (defaults to .vibemock.json / global)' },
        env: { type: 'string', description: 'Env name (defaults to .vibemock.json / global)' },
        purpose: { type: 'string', description: 'Audit purpose description' },
        ttl_seconds: { type: 'integer', minimum: 60, maximum: 2592000 },
      },
      required: ['purpose'],
      additionalProperties: false,
    },
  },
  {
    name: 'vibemock_forward_once',
    description:
      'Pull pending local://cli signed callbacks from VibeMock cloud and deliver them synchronously to a local HTTP endpoint without ngrok or background daemons.',
    inputSchema: {
      type: 'object',
      properties: {
        appid: { type: 'string' },
        env: { type: 'string' },
        target_url: {
          type: 'string',
          description: 'Local receiver URL (defaults to callback_url in .vibemock.json)',
        },
        timeout_ms: { type: 'integer', minimum: 500, maximum: 60000 },
        interval_ms: { type: 'integer', minimum: 100, maximum: 5000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'vibemock_trigger_webhook',
    description:
      'Directly synthesize and deliver a protocol-signed webhook event (without a prior sync API request). Defaults to local://cli and forwards once to target_url if provided.',
    inputSchema: {
      type: 'object',
      properties: {
        appid: { type: 'string' },
        env: { type: 'string' },
        event: { type: 'string', description: 'Event name (e.g. invoice.paid)' },
        biz_key: { type: 'string', description: 'Correlation business key' },
        payload: { description: 'JSON object or string webhook body' },
        target_url: { type: 'string', description: 'Local HTTP URL to forward the signed hook' },
        callback_url: {
          type: 'string',
          description: 'Optional verified cloud https:// URL (omit for local://cli)',
        },
        sign_algo: {
          type: 'string',
          enum: [
            'hmac-sha256',
            'hmac-sha256-base64',
            'github-sha256',
            'stripe-v1',
            'svix-v1',
            'none',
          ],
        },
        sign_header: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'vibemock_wait_record',
    description:
      'Wait for a mock record to reach terminal callback_status (none, sent, failed, skipped).',
    inputSchema: {
      type: 'object',
      properties: {
        appid: { type: 'string' },
        env: { type: 'string' },
        biz_key: { type: 'string' },
        trace_id: { type: 'string' },
        timeout_ms: { type: 'integer', minimum: 500, maximum: 60000 },
        interval_ms: { type: 'integer', minimum: 100, maximum: 5000 },
        consume: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'vibemock_records_list',
    description: 'List recent captured inbound requests and webhook callback outcomes.',
    inputSchema: {
      type: 'object',
      properties: {
        appid: { type: 'string' },
        env: { type: 'string' },
        biz_key: { type: 'string' },
        callback_status: { type: 'string', enum: ['none', 'pending', 'sent', 'failed', 'skipped'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
];

function sanitizeDefaultAppId(dirName: string): string {
  const cleaned = dirName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20);
  return cleaned || 'my-app';
}

function asOptionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function asOptionalNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function requireAppEnv(
  appid: string | undefined,
  envName: string | undefined,
): { appid: string; env: string } {
  if (!appid) {
    throw new Error(
      'Missing "appid" (pass it explicitly or initialize .vibemock.json via vibemock_init_project).',
    );
  }
  if (!envName) {
    throw new Error(
      'Missing "env" (pass it explicitly or initialize .vibemock.json via vibemock_init_project).',
    );
  }
  return { appid, env: envName };
}

async function executeMcpTool(
  name: string,
  args: Record<string, unknown>,
  deps: McpServerDeps,
): Promise<unknown> {
  const env = deps.env ?? process.env;
  const cwd = asOptionalString(args.cwd) ?? deps.cwd ?? process.cwd();
  const runtimeConfig = resolveRuntimeConfig({ cwd }, env);
  const client = new VibeMockClient({
    apiUrl: runtimeConfig.apiUrl,
    token: runtimeConfig.token,
    fetchImpl: deps.fetchImpl,
  });

  const resolveApp = () => asOptionalString(args.appid) ?? runtimeConfig.defaultApp;
  const resolveEnv = () => asOptionalString(args.env) ?? runtimeConfig.defaultEnv;

  switch (name) {
    case 'vibemock_whoami':
      return client.request('/_inspect/me');

    case 'vibemock_templates_list':
      return client.request('/_inspect/templates');

    case 'vibemock_init_project': {
      const targetPath = path.join(cwd, PROJECT_CONFIG_FILENAME);
      const force = args.force === true;
      if (fs.existsSync(targetPath) && !force) {
        throw new Error(
          `${PROJECT_CONFIG_FILENAME} already exists at ${targetPath}. Pass force: true to overwrite.`,
        );
      }
      const appid = asOptionalString(args.app) ?? sanitizeDefaultAppId(path.basename(cwd));
      const envName = asOptionalString(args.env) ?? 'dev';
      const callbackUrl = asOptionalString(args.callback_url);
      const saved = writeProjectConfigFile(
        {
          app: appid,
          env: envName,
          ...(callbackUrl ? { callback_url: callbackUrl } : {}),
        },
        targetPath,
      );

      let provisionedApp: unknown;
      let configuredEnv: unknown;
      if (runtimeConfig.token) {
        const tpl = asOptionalString(args.template);
        if (tpl) {
          try {
            provisionedApp = await client.request('/_inspect/apps/from-template', {
              method: 'POST',
              body: { template_id: tpl, appid },
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

      return {
        project_config_path: targetPath,
        config: saved,
        ...(provisionedApp ? { app: provisionedApp } : {}),
        ...(configuredEnv ? { env_config: configuredEnv } : {}),
      };
    }

    case 'vibemock_apps_create_from_template': {
      const templateId = asOptionalString(args.template_id);
      const appid = asOptionalString(args.appid);
      if (!templateId || !appid) {
        throw new Error('Both "template_id" and "appid" are required.');
      }
      const displayName = asOptionalString(args.name);
      return client.request('/_inspect/apps/from-template', {
        method: 'POST',
        body: {
          template_id: templateId,
          appid,
          ...(displayName ? { name: displayName } : {}),
        },
      });
    }

    case 'vibemock_env_set': {
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
        scenario:
          asOptionalString(args.scenario) ??
          (existing?.scenario as string | undefined) ??
          'success',
        sync_delay_ms:
          asOptionalNumber(args.sync_delay_ms) ??
          (existing?.sync_delay_ms as number | undefined) ??
          0,
        callback_delay_ms:
          asOptionalNumber(args.callback_delay_ms) ??
          (existing?.callback_delay_ms as number | undefined) ??
          1000,
        retry_count:
          asOptionalNumber(args.retry_count) ?? (existing?.retry_count as number | undefined) ?? 0,
      };
      if (args.callback_url === null) {
        payload.default_callback_url = null;
      } else {
        const cb = asOptionalString(args.callback_url);
        if (cb !== undefined) {
          payload.default_callback_url = cb.toLowerCase() === 'null' ? null : cb;
        } else if (existing?.default_callback_url !== undefined) {
          payload.default_callback_url = existing.default_callback_url;
        }
      }

      return client.request(
        `/_inspect/env-configs/${encodeURIComponent(appid)}/${encodeURIComponent(envName)}`,
        { method: 'PUT', body: payload },
      );
    }

    case 'vibemock_mock_url_create': {
      const { appid, env: envName } = requireAppEnv(resolveApp(), resolveEnv());
      const purpose = asOptionalString(args.purpose) ?? 'MCP agent self-test';
      const ttl = asOptionalNumber(args.ttl_seconds) ?? 7200;
      return client.request('/_inspect/mock-url-tokens', {
        method: 'POST',
        body: { appid, env: envName, purpose, ttl_seconds: ttl },
      });
    }

    case 'vibemock_forward_once': {
      const { appid, env: envName } = requireAppEnv(resolveApp(), resolveEnv());
      const targetUrl = asOptionalString(args.target_url) ?? runtimeConfig.callbackUrl;
      if (!targetUrl) {
        throw new Error(
          'Missing "target_url" (pass it explicitly or set callback_url in .vibemock.json).',
        );
      }
      const forwarded = await forwardLocalCallbacks(client, {
        appid,
        env: envName,
        targetUrl,
        once: true,
        timeoutMs: asOptionalNumber(args.timeout_ms) ?? 15_000,
        intervalMs: asOptionalNumber(args.interval_ms) ?? 500,
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
      });
      return { appid, env: envName, target_url: targetUrl, forwarded };
    }

    case 'vibemock_trigger_webhook': {
      const { appid, env: envName } = requireAppEnv(resolveApp(), resolveEnv());
      const event = asOptionalString(args.event);
      const bizKey = asOptionalString(args.biz_key);
      const cloudCallback = asOptionalString(args.callback_url);
      const explicitCloudUrl =
        cloudCallback && cloudCallback !== LOCAL_CLI_CALLBACK_URL ? cloudCallback : undefined;
      const localTargetUrl = asOptionalString(args.target_url) ?? runtimeConfig.callbackUrl;
      const signAlgo = asOptionalString(args.sign_algo);
      const signHeader = asOptionalString(args.sign_header);

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
          ...(args.payload !== undefined ? { payload: args.payload } : {}),
          ...(event ? { event } : {}),
          ...(bizKey ? { biz_key: bizKey } : {}),
          callback_url: explicitCloudUrl ?? LOCAL_CLI_CALLBACK_URL,
          ...(signAlgo ? { sign_algo: signAlgo } : {}),
          ...(signHeader ? { sign_header: signHeader } : {}),
        },
      });

      let forwarded: unknown;
      if (!explicitCloudUrl && localTargetUrl) {
        forwarded = await forwardLocalCallbacks(client, {
          appid,
          env: envName,
          targetUrl: localTargetUrl,
          once: true,
          timeoutMs: 15_000,
          intervalMs: 200,
          fetchImpl: deps.fetchImpl,
          sleep: deps.sleep,
        });
      }

      return { triggered, ...(forwarded ? { forwarded } : {}) };
    }

    case 'vibemock_wait_record': {
      const traceId = asOptionalString(args.trace_id);
      const appid = resolveApp();
      const envName = resolveEnv();
      if (!traceId && (!appid || !envName)) {
        throw new Error('Provide "trace_id" or both "appid" and "env".');
      }
      return waitForRecord(client, {
        traceId,
        appid,
        env: envName,
        bizKey: asOptionalString(args.biz_key),
        timeoutMs: asOptionalNumber(args.timeout_ms) ?? 15_000,
        intervalMs: asOptionalNumber(args.interval_ms) ?? 500,
        consume: args.consume === true,
        sleep: deps.sleep,
      });
    }

    case 'vibemock_records_list':
      return client.request('/_inspect/records', {
        query: {
          appid: resolveApp(),
          env: resolveEnv(),
          biz_key: asOptionalString(args.biz_key),
          callback_status: asOptionalString(args.callback_status),
          limit: asOptionalNumber(args.limit) ?? 20,
        },
      });

    default:
      throw new Error(`Unknown MCP tool "${name}"`);
  }
}

export async function handleMcpMessage(
  msg: JsonRpcRequest,
  deps: McpServerDeps,
): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;
  const method = msg.method;

  // Notifications without an id do not expect a JSON-RPC response
  if (msg.id === undefined && method?.startsWith('notifications/')) {
    return null;
  }

  if (!method) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32600, message: 'Invalid Request: missing method' },
    };
  }

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'vibemock',
          version: deps.version,
        },
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: MCP_TOOLS },
    };
  }

  if (method === 'tools/call') {
    const params = msg.params ?? {};
    const toolName = typeof params.name === 'string' ? params.name : '';
    const toolArgs =
      params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    if (!toolName) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Missing tool name in tools/call params' },
      };
    }

    try {
      const data = await executeMcpTool(toolName, toolArgs, deps);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: message }],
          isError: true,
        },
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

export async function runMcpServer(deps: McpServerDeps): Promise<void> {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const rl = readline.createInterface({ input: stdin, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      const errRes: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      };
      stdout.write(`${JSON.stringify(errRes)}\n`);
      continue;
    }

    const response = await handleMcpMessage(parsed, deps);
    if (response) {
      stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}
