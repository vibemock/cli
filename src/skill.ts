import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_NAME = 'vibemock';

export const AGENT_TARGETS = ['antigravity', 'claude-code', 'codex', 'cursor', 'agents'] as const;
export type AgentTarget = (typeof AGENT_TARGETS)[number];
export type SkillScope = 'project' | 'user';

export interface AgentTargetSpec {
  id: AgentTarget;
  label: string;
  projectDir: (cwd: string) => string;
  userDir: (home: string) => string;
  projectDetectDir: (cwd: string) => string;
  userDetectDir: (home: string) => string;
}

export const AGENT_SPECS: Record<AgentTarget, AgentTargetSpec> = {
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    projectDir: (cwd) => path.join(cwd, '.agents', 'skills', SKILL_NAME),
    userDir: (home) => path.join(home, '.gemini', 'antigravity', 'skills', SKILL_NAME),
    projectDetectDir: (cwd) => path.join(cwd, '.agents'),
    userDetectDir: (home) => path.join(home, '.gemini', 'antigravity'),
  },
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    projectDir: (cwd) => path.join(cwd, '.claude', 'skills', SKILL_NAME),
    userDir: (home) => path.join(home, '.claude', 'skills', SKILL_NAME),
    projectDetectDir: (cwd) => path.join(cwd, '.claude'),
    userDetectDir: (home) => path.join(home, '.claude'),
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    projectDir: (cwd) => path.join(cwd, '.agents', 'skills', SKILL_NAME),
    userDir: (home) => path.join(home, '.codex', 'skills', SKILL_NAME),
    projectDetectDir: (cwd) => path.join(cwd, '.codex'),
    userDetectDir: (home) => path.join(home, '.codex'),
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    projectDir: (cwd) => path.join(cwd, '.cursor', 'skills', SKILL_NAME),
    userDir: (home) => path.join(home, '.cursor', 'skills', SKILL_NAME),
    projectDetectDir: (cwd) => path.join(cwd, '.cursor'),
    userDetectDir: (home) => path.join(home, '.cursor'),
  },
  agents: {
    id: 'agents',
    label: 'Agent Skills Standard (.agents)',
    projectDir: (cwd) => path.join(cwd, '.agents', 'skills', SKILL_NAME),
    userDir: (home) => path.join(home, '.agents', 'skills', SKILL_NAME),
    projectDetectDir: (cwd) => path.join(cwd, '.agents'),
    userDetectDir: (home) => path.join(home, '.agents'),
  },
};

export function isAgentTarget(value: string): value is AgentTarget {
  return (AGENT_TARGETS as readonly string[]).includes(value);
}

export function getBundledSkillDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', 'skills', SKILL_NAME),
    path.resolve(here, '..', '..', 'skills', SKILL_NAME),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
      return dir;
    }
  }
  throw new Error(`Bundled skill directory "${SKILL_NAME}" not found.`);
}

export function readBundledSkillContent(): string {
  return fs.readFileSync(path.join(getBundledSkillDir(), 'SKILL.md'), 'utf8');
}

export interface SkillStatusEntry {
  agent: AgentTarget;
  label: string;
  project_path: string;
  project_installed: boolean;
  user_path: string;
  user_installed: boolean;
}

export function listSkillTargets(
  cwd = process.cwd(),
  home = process.env.HOME?.trim() || os.homedir(),
): SkillStatusEntry[] {
  return AGENT_TARGETS.map((id) => {
    const spec = AGENT_SPECS[id];
    const projectPath = spec.projectDir(cwd);
    const userPath = spec.userDir(home);
    return {
      agent: id,
      label: spec.label,
      project_path: projectPath,
      project_installed: fs.existsSync(path.join(projectPath, 'SKILL.md')),
      user_path: userPath,
      user_installed: fs.existsSync(path.join(userPath, 'SKILL.md')),
    };
  });
}

export function detectAgents(
  scope: SkillScope,
  cwd = process.cwd(),
  home = process.env.HOME?.trim() || os.homedir(),
): AgentTarget[] {
  const detected: AgentTarget[] = [];
  for (const id of AGENT_TARGETS) {
    if (id === 'agents') continue;
    const spec = AGENT_SPECS[id];
    const detectDir = scope === 'project' ? spec.projectDetectDir(cwd) : spec.userDetectDir(home);
    if (fs.existsSync(detectDir)) {
      detected.push(id);
    }
  }
  return detected.length > 0 ? detected : ['agents'];
}

export function parseAgentSelection(
  raw: string | undefined,
  scope: SkillScope,
  cwd = process.cwd(),
  home = process.env.HOME?.trim() || os.homedir(),
): AgentTarget[] {
  if (!raw || raw === 'auto') {
    return detectAgents(scope, cwd, home);
  }
  if (raw === 'all') {
    return [...AGENT_TARGETS];
  }
  const parts = raw
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) {
    return detectAgents(scope, cwd, home);
  }
  const result: AgentTarget[] = [];
  for (const part of parts) {
    if (!isAgentTarget(part)) {
      throw new Error(
        `Unknown agent "${part}". Supported agents: ${AGENT_TARGETS.join(', ')}, all, auto.`,
      );
    }
    if (!result.includes(part)) {
      result.push(part);
    }
  }
  return result;
}

export interface InstallDestination {
  targetPath: string;
  agents: string[];
}

export function resolveDestinations(options: {
  agents?: string;
  scope: SkillScope;
  customDir?: string;
  cwd?: string;
  home?: string;
}): InstallDestination[] {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? (process.env.HOME?.trim() || os.homedir());

  if (options.customDir) {
    const resolved = path.resolve(cwd, options.customDir);
    const targetPath =
      path.basename(resolved) === SKILL_NAME ? resolved : path.join(resolved, SKILL_NAME);
    return [{ targetPath, agents: ['custom'] }];
  }

  const selected = parseAgentSelection(options.agents, options.scope, cwd, home);
  const byPath = new Map<string, string[]>();
  for (const agent of selected) {
    const spec = AGENT_SPECS[agent];
    const targetPath = options.scope === 'project' ? spec.projectDir(cwd) : spec.userDir(home);
    const list = byPath.get(targetPath) ?? [];
    list.push(agent);
    byPath.set(targetPath, list);
  }

  return Array.from(byPath.entries()).map(([targetPath, agents]) => ({
    targetPath,
    agents,
  }));
}

export interface InstallResultItem {
  target_path: string;
  agents: string[];
  status: 'installed' | 'updated' | 'skipped' | 'would_install' | 'would_update';
}

export function installSkill(options: {
  agents?: string;
  scope: SkillScope;
  customDir?: string;
  force?: boolean;
  dryRun?: boolean;
  cwd?: string;
  home?: string;
}): InstallResultItem[] {
  const sourceDir = getBundledSkillDir();
  const destinations = resolveDestinations(options);
  const results: InstallResultItem[] = [];

  for (const dest of destinations) {
    const exists = fs.existsSync(path.join(dest.targetPath, 'SKILL.md'));
    if (exists && !options.force) {
      results.push({
        target_path: dest.targetPath,
        agents: dest.agents,
        status: 'skipped',
      });
      continue;
    }

    if (options.dryRun) {
      results.push({
        target_path: dest.targetPath,
        agents: dest.agents,
        status: exists ? 'would_update' : 'would_install',
      });
      continue;
    }

    fs.mkdirSync(dest.targetPath, { recursive: true });
    fs.cpSync(sourceDir, dest.targetPath, { recursive: true, force: true });
    results.push({
      target_path: dest.targetPath,
      agents: dest.agents,
      status: exists ? 'updated' : 'installed',
    });
  }

  return results;
}

export interface UninstallResultItem {
  target_path: string;
  agents: string[];
  status: 'removed' | 'not_found' | 'would_remove';
}

export function uninstallSkill(options: {
  agents?: string;
  scope: SkillScope;
  customDir?: string;
  dryRun?: boolean;
  cwd?: string;
  home?: string;
}): UninstallResultItem[] {
  const destinations = resolveDestinations(options);
  const results: UninstallResultItem[] = [];

  for (const dest of destinations) {
    const exists = fs.existsSync(dest.targetPath);
    if (!exists) {
      results.push({
        target_path: dest.targetPath,
        agents: dest.agents,
        status: 'not_found',
      });
      continue;
    }

    if (options.dryRun) {
      results.push({
        target_path: dest.targetPath,
        agents: dest.agents,
        status: 'would_remove',
      });
      continue;
    }

    fs.rmSync(dest.targetPath, { recursive: true, force: true });
    results.push({
      target_path: dest.targetPath,
      agents: dest.agents,
      status: 'removed',
    });
  }

  return results;
}
