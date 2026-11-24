import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  installSkill,
  listSkillTargets,
  readBundledSkillContent,
  uninstallSkill,
} from '../src/skill.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibemock-cli-skill-'));
}

describe('skill installer', () => {
  it('installs to multiple agents, deduplicates shared project paths, and handles force/dry-run/uninstall', () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    try {
      // antigravity + codex + agents share .agents/skills/vibemock in project scope
      const dryRun = installSkill({
        agents: 'antigravity,codex,claude-code',
        scope: 'project',
        dryRun: true,
        cwd,
        home,
      });
      assert.equal(dryRun.length, 2);
      assert.equal(dryRun[0]?.status, 'would_install');
      assert.equal(
        fs.existsSync(path.join(cwd, '.agents', 'skills', 'vibemock', 'SKILL.md')),
        false,
      );

      const installed = installSkill({
        agents: 'antigravity,codex,claude-code',
        scope: 'project',
        cwd,
        home,
      });
      assert.equal(installed.length, 2);
      assert.deepEqual(
        installed.map((r) => r.status),
        ['installed', 'installed'],
      );
      assert.equal(
        fs.existsSync(path.join(cwd, '.agents', 'skills', 'vibemock', 'SKILL.md')),
        true,
      );
      assert.equal(
        fs.existsSync(path.join(cwd, '.claude', 'skills', 'vibemock', 'SKILL.md')),
        true,
      );

      const content = fs.readFileSync(
        path.join(cwd, '.claude', 'skills', 'vibemock', 'SKILL.md'),
        'utf8',
      );
      assert.equal(content, readBundledSkillContent());

      // Second install without --force skips
      const skipped = installSkill({
        agents: 'claude-code',
        scope: 'project',
        cwd,
        home,
      });
      assert.equal(skipped[0]?.status, 'skipped');

      // With --force updates
      const updated = installSkill({
        agents: 'claude-code',
        scope: 'project',
        force: true,
        cwd,
        home,
      });
      assert.equal(updated[0]?.status, 'updated');

      // listSkillTargets reflects installed status
      const listed = listSkillTargets(cwd, home);
      const claudeEntry = listed.find((e) => e.agent === 'claude-code');
      assert.equal(claudeEntry?.project_installed, true);
      assert.equal(claudeEntry?.user_installed, false);

      // Uninstall removes directory
      const removed = uninstallSkill({
        agents: 'claude-code',
        scope: 'project',
        cwd,
        home,
      });
      assert.equal(removed[0]?.status, 'removed');
      assert.equal(fs.existsSync(path.join(cwd, '.claude', 'skills', 'vibemock')), false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('auto-detects existing agent directories in user scope and supports custom --dir', () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    try {
      fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true });

      const results = installSkill({
        agents: 'auto',
        scope: 'user',
        cwd,
        home,
      });
      assert.equal(results.length, 2);
      assert.equal(
        fs.existsSync(path.join(home, '.cursor', 'skills', 'vibemock', 'SKILL.md')),
        true,
      );
      assert.equal(
        fs.existsSync(path.join(home, '.codex', 'skills', 'vibemock', 'SKILL.md')),
        true,
      );

      const custom = installSkill({
        scope: 'project',
        customDir: path.join(cwd, 'my-custom-skills'),
        cwd,
        home,
      });
      assert.equal(custom.length, 1);
      assert.equal(fs.existsSync(path.join(cwd, 'my-custom-skills', 'vibemock', 'SKILL.md')), true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
