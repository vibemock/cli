import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_API_URL, updateConfigValues } from '../src/config.js';
import { MCP_TOOLS, handleMcpMessage } from '../src/mcp.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibemock-mcp-test-'));
}

describe('MCP server & Cursor plugin bundle', () => {
  it('handles initialize, ping, tools/list, and ignores notifications', async () => {
    const initRes = await handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { version: '1.2.0' },
    );
    assert.ok(initRes);
    const initResult = initRes.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
    };
    assert.equal(initResult.protocolVersion, '2024-11-05');
    assert.equal(initResult.serverInfo.name, 'vibemock');
    assert.equal(initResult.serverInfo.version, '1.2.0');

    const notifRes = await handleMcpMessage(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { version: '1.2.0' },
    );
    assert.equal(notifRes, null);

    const pingRes = await handleMcpMessage(
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      { version: '1.2.0' },
    );
    assert.deepEqual(pingRes?.result, {});

    const listRes = await handleMcpMessage(
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { version: '1.2.0' },
    );
    const tools = (listRes?.result as { tools: Array<{ name: string }> }).tools;
    assert.equal(tools.length, 10);
    assert.equal(tools.length, MCP_TOOLS.length);
  });

  it('executes vibemock_whoami, vibemock_init_project, and vibemock_trigger_webhook via tools/call', async () => {
    const tmpHome = makeTempDir();
    const tmpProj = makeTempDir();
    try {
      const env = { HOME: tmpHome } as NodeJS.ProcessEnv;
      updateConfigValues(
        { token: 'vmk_ins_mcp_test_123456' },
        path.join(tmpHome, '.config', 'vibemock', 'config.json'),
      );

      let forwardedPayload = '';
      const mockFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url === `${DEFAULT_API_URL}/_inspect/me`) {
          return new Response(
            JSON.stringify({ principal: { email: 'agent@test.dev', role: 'member' } }),
            { status: 200 },
          );
        }
        if (url.includes('/_inspect/env-configs/') && init?.method === 'PUT') {
          return new Response(JSON.stringify({ env_config: { scenario: 'success' } }), {
            status: 200,
          });
        }
        if (url === `${DEFAULT_API_URL}/_inspect/trigger` && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              trace_id: 'tr_mcp_1',
              appid: 'mcp-app',
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
                  trace_id: 'tr_mcp_1',
                  appid: 'mcp-app',
                  env: 'dev',
                  biz_key: 'invoice.paid',
                  callback_url: 'local://cli',
                  callback_status: 'pending',
                  callback_payload: '{"event":"invoice.paid"}',
                  callback_headers_json: JSON.stringify({
                    'content-type': 'application/json',
                    'Stripe-Signature': 't=1,v1=sig',
                  }),
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url === 'http://localhost:4100/hook' && init?.method === 'POST') {
          forwardedPayload = String(init.body ?? '');
          return new Response('ok', { status: 200 });
        }
        if (
          url === `${DEFAULT_API_URL}/_inspect/records/tr_mcp_1/callback-result` &&
          init?.method === 'POST'
        ) {
          return new Response(JSON.stringify({ record: { callback_status: 'sent' } }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 });
      };

      const deps = {
        version: '1.2.0',
        env,
        cwd: tmpProj,
        fetchImpl: mockFetch,
        sleep: async () => {},
      };

      const whoamiRes = await handleMcpMessage(
        {
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: { name: 'vibemock_whoami', arguments: {} },
        },
        deps,
      );
      const whoamiData = JSON.parse(
        (whoamiRes?.result as { content: Array<{ text: string }> }).content[0]?.text ?? '{}',
      ) as { principal: { email: string } };
      assert.equal(whoamiData.principal.email, 'agent@test.dev');

      const initRes = await handleMcpMessage(
        {
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: 'vibemock_init_project',
            arguments: {
              app: 'mcp-app',
              env: 'dev',
              callback_url: 'http://localhost:4100/hook',
            },
          },
        },
        deps,
      );
      assert.equal((initRes?.result as { isError?: boolean }).isError, undefined);
      const projRaw = JSON.parse(
        fs.readFileSync(path.join(tmpProj, '.vibemock.json'), 'utf8'),
      ) as Record<string, unknown>;
      assert.equal(projRaw.app, 'mcp-app');
      assert.equal(projRaw.token, undefined);

      const trigRes = await handleMcpMessage(
        {
          jsonrpc: '2.0',
          id: 12,
          method: 'tools/call',
          params: {
            name: 'vibemock_trigger_webhook',
            arguments: { event: 'invoice.paid', payload: { event: 'invoice.paid' } },
          },
        },
        deps,
      );
      assert.equal((trigRes?.result as { isError?: boolean }).isError, undefined);
      assert.equal(forwardedPayload, '{"event":"invoice.paid"}');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });

  it('has a valid Cursor single-plugin bundle in packages/cursor-plugin', (t) => {
    const pluginRoot = path.resolve(import.meta.dirname, '../../../cursor-plugin');
    if (!fs.existsSync(pluginRoot)) {
      t.skip('Cursor plugin bundle not present outside monorepo');
      return;
    }
    const pluginJsonPath = path.join(pluginRoot, '.cursor-plugin', 'plugin.json');
    const marketplaceJsonPath = path.join(pluginRoot, '.cursor-plugin', 'marketplace.json');

    assert.equal(fs.existsSync(marketplaceJsonPath), false);

    const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8')) as {
      name: string;
      version: string;
      license: string;
      repository: string;
      logo: string;
      mcpServers: string;
      rules: string;
      commands: string;
      skills: string;
    };
    assert.match(pluginJson.name, /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
    assert.equal(pluginJson.license, 'Apache-2.0');
    assert.equal(pluginJson.repository, 'https://github.com/vibemock/cursor-plugin');
    assert.equal(fs.existsSync(path.join(pluginRoot, 'LICENSE')), true);
    assert.equal(fs.existsSync(path.join(pluginRoot, pluginJson.logo)), true);
    assert.equal(fs.existsSync(path.join(pluginRoot, pluginJson.mcpServers)), true);
    for (const rel of [pluginJson.rules, pluginJson.commands, pluginJson.skills]) {
      assert.equal(fs.existsSync(path.join(pluginRoot, rel)), true);
    }

    const checkFrontmatter = (filePath: string, requiredKeys: string[]) => {
      const content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
      assert.equal(content.startsWith('---\n'), true, `${filePath} missing YAML frontmatter`);
      const endIdx = content.indexOf('\n---\n', 4);
      assert.notEqual(endIdx, -1, `${filePath} missing closing YAML frontmatter`);
      const block = content.slice(4, endIdx);
      for (const key of requiredKeys) {
        assert.match(
          block,
          new RegExp(`^${key}:\\s*.+`, 'm'),
          `${filePath} missing frontmatter key: ${key}`,
        );
      }
    };

    checkFrontmatter(path.join(pluginRoot, 'rules/vibemock-webhooks.mdc'), ['description']);
    checkFrontmatter(path.join(pluginRoot, 'skills/vibemock/SKILL.md'), ['name', 'description']);
    checkFrontmatter(path.join(pluginRoot, 'commands/vibemock-test.md'), ['name', 'description']);
  });
});
