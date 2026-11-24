# @vibemock/cli

Standalone, zero-dependency CLI for VibeMock inspection, scenario switching, async callback waiting, tunnel-free local webhook forwarding, and multi-agent skill installation.

Supports protocol-accurate webhook signing (`stripe-v1`, `github-sha256`, `svix-v1`, `hmac-sha256`, `hmac-sha256-base64`) so official SDKs verify callbacks unmodified.

## Installation

Requires Node.js `>= 20.0.0`:

```sh
npm i -g @vibemock/cli
```

## Configuration

Config is stored at `~/.config/vibemock/config.json` (mode `0600`).
If `api_url` is not set, it defaults to `https://api.vibemock.bid`.

```sh
# Save your Inspect Token (never committed to git)
vibemock config set --token <inspect_token>

# Optional: override API URL (e.g. local wrangler dev)
vibemock config set --api-url http://api.localhost:8787

# Optional: set default app and env
vibemock config set --default-app wxpay-01 --default-env agent-local

# Or use key/value syntax
vibemock config set api_url https://api.vibemock.bid

# View effective config and sources (token is always masked)
vibemock config show

# Reset api_url back to default (https://api.vibemock.bid)
vibemock config unset api_url
```

Precedence: CLI flags (`--api-url`, `--token`) > Environment variables (`VIBEMOCK_API_URL`, `VIBEMOCK_TOKEN`) > Project `.vibemock.json` (upward lookup, never stores `token`) > `~/.config/vibemock/config.json` > Default (`https://api.vibemock.bid`).

Initialize a project-scoped `.vibemock.json` (safe to commit, contains no secrets):

```sh
vibemock init --app my-stripe --env proj-a --callback-url http://localhost:3000/api/webhook --template stripe-checkout --json
```

## Install Agent Skills

```sh
# Auto-detect installed agents in the current project (or user scope)
vibemock skill install
vibemock skill install --scope user

# Install for specific agents (antigravity, claude-code, codex, cursor, agents, all)
vibemock skill install --agent antigravity,claude-code,cursor --scope project

# Install to a custom skills directory
vibemock skill install --dir ./my-skills

# Inspect installation status or print bundled SKILL.md
vibemock skill list
vibemock skill print
```

## Common Self-Test Loop

```sh
vibemock whoami --json
vibemock templates list --json
vibemock apps create-from-template stripe-checkout --app my-stripe --json
vibemock env set --app my-stripe --env dev --scenario success --callback-url local://cli --json
vibemock mock-url create --app my-stripe --env dev --purpose "Local agent test" --ttl 3600 --json
vibemock forward --app my-stripe --env dev --to http://localhost:3000/api/webhook --once
vibemock trigger --app my-stripe --env dev --event invoice.paid --payload '{"type":"invoice.paid"}' --to http://localhost:3000/api/webhook --json
vibemock wait --app my-stripe --env dev --biz-key ORDER-1001 --timeout 15000 --json
vibemock records clear --app my-stripe --env dev --biz-key ORDER-1001 --json
```
