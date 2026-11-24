import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CLI_VERSION, runCli } from '../src/cli.js';
import { DEFAULT_API_URL } from '../src/config.js';

function makeBufferIO() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    },
    stdout,
    stderr,
  };
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibemock-cli-e2e-'));
}

describe('CLI commands', () => {
  it('supports config set/get/show/unset using ~/.config/vibemock/config.json and default URL', async () => {
    const tmpHome = makeTempDir();
    try {
      const env = { HOME: tmpHome } as NodeJS.ProcessEnv;

      // 1. Default show before setting anything
      const show1 = makeBufferIO();
      const code1 = await runCli(['config', 'show', '--json'], { io: show1.io, env });
      assert.equal(code1, 0);
      const parsed1 = JSON.parse(show1.stdout.join('\n')) as Record<string, unknown>;
      assert.equal(parsed1.api_url, DEFAULT_API_URL);
      assert.equal(parsed1.api_url_source, 'default');
      assert.equal(parsed1.token_configured, false);

      // 2. Set via key/value and flags
      const set1 = makeBufferIO();
      const code2 = await runCli(
        [
          'config',
          'set',
          'token',
          'vmk_inspect_abcdef123456',
          '--default-app',
          'wxpay-01',
          '--json',
        ],
        { io: set1.io, env },
      );
      assert.equal(code2, 0);
      const setRes = JSON.parse(set1.stdout.join('\n')) as Record<string, unknown>;
      assert.equal(setRes.api_url, DEFAULT_API_URL);
      assert.equal(setRes.default_app, 'wxpay-01');
      // Never print raw token
      assert.equal(String(setRes.token).includes('abcdef123456'), false);

      // 3. Override api_url via flag style
      const set2 = makeBufferIO();
      const code3 = await runCli(
        ['config', 'set', '--api-url', 'http://api.localhost:8787', '--json'],
        { io: set2.io, env },
      );
      assert.equal(code3, 0);

      const get1 = makeBufferIO();
      const code4 = await runCli(['config', 'get', 'api_url', '--json'], { io: get1.io, env });
      assert.equal(code4, 0);
      assert.equal(JSON.parse(get1.stdout.join('\n')).value, 'http://api.localhost:8787');

      // 4. Unset api_url -> back to default
      const unset1 = makeBufferIO();
      const code5 = await runCli(['config', 'unset', 'api_url', '--json'], { io: unset1.io, env });
      assert.equal(code5, 0);

      const get2 = makeBufferIO();
      await runCli(['config', 'get', 'api_url', '--json'], { io: get2.io, env });
      const get2Parsed = JSON.parse(get2.stdout.join('\n')) as Record<string, unknown>;
      assert.equal(get2Parsed.value, DEFAULT_API_URL);
      assert.equal(get2Parsed.source, 'default');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('merges existing env-config on `env set` and polls until terminal status on `wait`', async () => {
    const tmpHome = makeTempDir();
    try {
      const env = { HOME: tmpHome } as NodeJS.ProcessEnv;
      await runCli(
        [
          'config',
          'set',
          '--token',
          'vmk_test_token_12345678',
          '--default-app',
          'pay',
          '--default-env',
          'dev',
        ],
        { io: makeBufferIO().io, env },
      );

      const requests: Array<{ url: string; method: string; body?: string }> = [];
      let pollCount = 0;

      const mockFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        requests.push({
          url,
          method,
          body: typeof init?.body === 'string' ? init.body : undefined,
        });

        if (url === `${DEFAULT_API_URL}/_inspect/env-configs/pay/dev` && method === 'GET') {
          return new Response(
            JSON.stringify({
              env_config: {
                appid: 'pay',
                env: 'dev',
                scenario: 'success',
                default_callback_url: 'https://hook.example.com/cb',
                sync_delay_ms: 200,
                callback_delay_ms: 800,
                retry_count: 1,
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (url === `${DEFAULT_API_URL}/_inspect/env-configs/pay/dev` && method === 'PUT') {
          return new Response(JSON.stringify({ env_config: JSON.parse(String(init?.body)) }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (url.startsWith(`${DEFAULT_API_URL}/_inspect/records?`)) {
          pollCount += 1;
          const status = pollCount < 2 ? 'pending' : 'sent';
          return new Response(
            JSON.stringify({
              records: [
                {
                  trace_id: 'tr_001',
                  appid: 'pay',
                  env: 'dev',
                  biz_key: 'ORDER-99',
                  method: 'POST',
                  path: '/v1/charge',
                  sync_status: 200,
                  callback_status: status,
                  callback_http_status: status === 'sent' ? 200 : null,
                  inbound_body: '{"order_no":"ORDER-99"}',
                  inbound_body_truncated: 0,
                  callback_response_body: status === 'sent' ? 'ok' : null,
                  created_at: '2026-11-22T00:00:00.000Z',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (url === `${DEFAULT_API_URL}/_inspect/records/tr_001?consume=true`) {
          return new Response(JSON.stringify({ consumed: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(
          JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }),
          {
            status: 404,
          },
        );
      };

      // 1. env set only overrides --scenario, preserves default_callback_url & delays
      const envOut = makeBufferIO();
      const envCode = await runCli(['env', 'set', '--scenario', 'sync_fail', '--json'], {
        io: envOut.io,
        env,
        fetchImpl: mockFetch,
      });
      assert.equal(envCode, 0);
      const putReq = requests.find((r) => r.method === 'PUT');
      assert.ok(putReq?.body);
      const putBody = JSON.parse(putReq.body) as Record<string, unknown>;
      assert.equal(putBody.scenario, 'sync_fail');
      assert.equal(putBody.default_callback_url, 'https://hook.example.com/cb');
      assert.equal(putBody.sync_delay_ms, 200);
      assert.equal(putBody.callback_delay_ms, 800);
      assert.equal(putBody.retry_count, 1);

      // 2. wait polls until callback_status becomes 'sent' and consumes record
      const waitOut = makeBufferIO();
      const waitCode = await runCli(
        [
          'wait',
          '--biz-key',
          'ORDER-99',
          '--timeout',
          '5000',
          '--interval',
          '10',
          '--consume',
          '--json',
        ],
        {
          io: waitOut.io,
          env,
          fetchImpl: mockFetch,
          sleep: async () => {},
        },
      );
      assert.equal(waitCode, 0);
      const waitRes = JSON.parse(waitOut.stdout.join('\n')) as {
        attempts: number;
        consumed: boolean;
        record: { trace_id: string; callback_status: string };
      };
      assert.equal(waitRes.attempts, 2);
      assert.equal(waitRes.consumed, true);
      assert.equal(waitRes.record.trace_id, 'tr_001');
      assert.equal(waitRes.record.callback_status, 'sent');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('installs skill via `vibemock skill install`', async () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    try {
      const out = makeBufferIO();
      const code = await runCli(
        ['skill', 'install', '--agent', 'antigravity,claude-code', '--scope', 'project', '--json'],
        { io: out.io, cwd, home, env: { HOME: home } },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(out.stdout.join('\n')) as {
        results: Array<{ status: string; target_path: string }>;
      };
      assert.equal(parsed.results.length, 2);
      assert.equal(
        fs.existsSync(path.join(cwd, '.agents', 'skills', 'vibemock', 'SKILL.md')),
        true,
      );
      assert.equal(
        fs.existsSync(path.join(cwd, '.claude', 'skills', 'vibemock', 'SKILL.md')),
        true,
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('forwards local://cli callbacks with --to overriding config callback_url and strips unsafe headers', async () => {
    const tmpHome = makeTempDir();
    try {
      const env = { HOME: tmpHome } as NodeJS.ProcessEnv;
      await runCli(
        [
          'config',
          'set',
          '--token',
          'vmk_test_token_12345678',
          '--default-app',
          'stripe-01',
          '--default-env',
          'dev',
          '--callback-url',
          'http://localhost:3000/default-cb',
        ],
        { io: makeBufferIO().io, env },
      );

      let localReceivedUrl = '';
      let localReceivedHeaders: Record<string, string> = {};
      const reportedBodies: Array<Record<string, unknown>> = [];

      const mockFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';

        if (url === `${DEFAULT_API_URL}/_inspect/env-configs/stripe-01/dev` && method === 'GET') {
          return new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 });
        }
        if (url === `${DEFAULT_API_URL}/_inspect/env-configs/stripe-01/dev` && method === 'PUT') {
          return new Response(JSON.stringify({ env_config: JSON.parse(String(init?.body)) }), {
            status: 200,
          });
        }
        if (url.startsWith(`${DEFAULT_API_URL}/_inspect/records?`)) {
          return new Response(
            JSON.stringify({
              records: [
                {
                  trace_id: 'tr_local_99',
                  appid: 'stripe-01',
                  env: 'dev',
                  biz_key: 'SUB-1',
                  callback_url: 'local://cli',
                  callback_status: 'pending',
                  callback_payload: '{"event":"checkout.session.completed"}',
                  callback_headers_json: JSON.stringify({
                    'content-type': 'application/json',
                    'Stripe-Signature': 'deadbeef',
                    cookie: 'secret=1',
                    authorization: 'Bearer leak',
                  }),
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url === 'http://localhost:4000/override-cb' && method === 'POST') {
          localReceivedUrl = url;
          localReceivedHeaders = (init?.headers as Record<string, string>) ?? {};
          return new Response('received', { status: 200 });
        }
        if (
          url === `${DEFAULT_API_URL}/_inspect/records/tr_local_99/callback-result` &&
          method === 'POST'
        ) {
          reportedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(
            JSON.stringify({ record: { trace_id: 'tr_local_99', callback_status: 'sent' } }),
            { status: 200 },
          );
        }
        return new Response('not found', { status: 404 });
      };

      const out = makeBufferIO();
      const code = await runCli(
        ['forward', '--to', 'http://localhost:4000/override-cb', '--once', '--json'],
        { io: out.io, env, fetchImpl: mockFetch, sleep: async () => {} },
      );
      assert.equal(code, 0);
      assert.equal(localReceivedUrl, 'http://localhost:4000/override-cb');
      assert.equal(localReceivedHeaders['Stripe-Signature'], 'deadbeef');
      assert.equal(localReceivedHeaders.cookie, undefined);
      assert.equal(localReceivedHeaders.authorization, undefined);
      assert.equal(reportedBodies[0]?.status, 'sent');
      assert.equal(reportedBodies[0]?.http_status, 200);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('reads version from package.json, prints inbound_method/inbound_path in records list, and supports apps create', async () => {
    const tmpHome = makeTempDir();
    try {
      assert.equal(CLI_VERSION, '1.2.1');
      const env = { HOME: tmpHome } as NodeJS.ProcessEnv;
      await runCli(['config', 'set', '--token', 'vmk_test_token_12345678'], {
        io: makeBufferIO().io,
        env,
      });

      let createdPayload: Record<string, unknown> | undefined;
      const mockFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.startsWith(`${DEFAULT_API_URL}/_inspect/records`)) {
          return new Response(
            JSON.stringify({
              records: [
                {
                  trace_id: 'tr_01',
                  appid: 'stripe-01',
                  env: 'dev',
                  biz_key: 'ORD-1',
                  inbound_method: 'POST',
                  inbound_path: '/v1/checkout/sessions',
                  sync_status: 200,
                  callback_status: 'sent',
                  created_at: '2026-11-23T00:00:00Z',
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url === `${DEFAULT_API_URL}/_inspect/apps` && init?.method === 'POST') {
          createdPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({ app: createdPayload }), { status: 201 });
        }
        return new Response('not found', { status: 404 });
      };

      const recOut = makeBufferIO();
      const recCode = await runCli(['records', 'list'], {
        io: recOut.io,
        env,
        fetchImpl: mockFetch,
      });
      assert.equal(recCode, 0);
      const tableText = recOut.stdout.join('\n');
      assert.equal(tableText.includes('POST /v1/checkout/sessions'), true);
      assert.equal(tableText.includes('undefined'), false);

      const createOut = makeBufferIO();
      const createCode = await runCli(
        ['apps', 'create', 'custom-app', '--name', 'Custom App', '--description', 'My mock'],
        { io: createOut.io, env, fetchImpl: mockFetch },
      );
      assert.equal(createCode, 0);
      assert.equal(createdPayload?.appid, 'custom-app');
      assert.equal(createdPayload?.name, 'Custom App');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('supports `vibemock init` (without storing token) and `vibemock trigger` one-shot local forward', async () => {
    const tmpHome = makeTempDir();
    const tmpProject = makeTempDir();
    try {
      const env = { HOME: tmpHome } as NodeJS.ProcessEnv;
      await runCli(['config', 'set', '--token', 'vmk_test_token_12345678'], {
        io: makeBufferIO().io,
        env,
      });

      const initOut = makeBufferIO();
      const initCode = await runCli(
        [
          'init',
          '--app',
          'proj-billing',
          '--env',
          'dev',
          '--callback-url',
          'http://localhost:4000/hook',
          '--json',
        ],
        {
          io: initOut.io,
          env,
          cwd: tmpProject,
          fetchImpl: async (input, init) => {
            const url = String(input);
            if (url.includes('/_inspect/env-configs/') && init?.method === 'PUT') {
              return new Response(JSON.stringify({ env_config: { scenario: 'success' } }), {
                status: 200,
              });
            }
            return new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 });
          },
        },
      );
      assert.equal(initCode, 0);
      const projectJson = JSON.parse(
        fs.readFileSync(path.join(tmpProject, '.vibemock.json'), 'utf8'),
      ) as Record<string, unknown>;
      assert.equal(projectJson.app, 'proj-billing');
      assert.equal(projectJson.env, 'dev');
      assert.equal(projectJson.callback_url, 'http://localhost:4000/hook');
      assert.equal(projectJson.token, undefined);

      let triggerBody: Record<string, unknown> | undefined;
      let localReceived = '';
      const mockFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url === `${DEFAULT_API_URL}/_inspect/trigger` && init?.method === 'POST') {
          triggerBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response(
            JSON.stringify({
              trace_id: 'tr_trig_1',
              appid: 'proj-billing',
              env: 'dev',
              biz_key: 'invoice.paid',
              callback_status: 'pending',
              callback_url: 'local://cli',
              is_local_forward: true,
            }),
            { status: 201 },
          );
        }
        if (url.startsWith(`${DEFAULT_API_URL}/_inspect/records?`)) {
          return new Response(
            JSON.stringify({
              records: [
                {
                  trace_id: 'tr_trig_1',
                  appid: 'proj-billing',
                  env: 'dev',
                  biz_key: 'invoice.paid',
                  callback_url: 'local://cli',
                  callback_status: 'pending',
                  callback_payload: '{"type":"invoice.paid"}',
                  callback_headers_json: JSON.stringify({
                    'content-type': 'application/json',
                    'Stripe-Signature': 't=1,v1=abc',
                  }),
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url === 'http://localhost:4000/hook' && init?.method === 'POST') {
          localReceived = String(init.body ?? '');
          return new Response('ok', { status: 200 });
        }
        if (
          url === `${DEFAULT_API_URL}/_inspect/records/tr_trig_1/callback-result` &&
          init?.method === 'POST'
        ) {
          return new Response(JSON.stringify({ record: { callback_status: 'sent' } }), {
            status: 200,
          });
        }
        return new Response('not found', { status: 404 });
      };

      const trigOut = makeBufferIO();
      const trigCode = await runCli(
        ['trigger', '--event', 'invoice.paid', '--payload', '{"type":"invoice.paid"}', '--json'],
        {
          io: trigOut.io,
          env,
          cwd: tmpProject,
          fetchImpl: mockFetch,
          sleep: async () => {},
        },
      );
      assert.equal(trigCode, 0);
      assert.equal(triggerBody?.appid, 'proj-billing');
      assert.equal(triggerBody?.env, 'dev');
      assert.equal(triggerBody?.callback_url, 'local://cli');
      assert.equal(localReceived, '{"type":"invoice.paid"}');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpProject, { recursive: true, force: true });
    }
  });
});
