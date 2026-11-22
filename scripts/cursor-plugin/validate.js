#!/usr/bin/env node
'use strict';

/**
 * Validates build/cursor-plugin/ecc-cursor against the Cursor plugin
 * checklist (cursor.com/docs/reference/plugins; PLAN.md section 3):
 *   - .cursor-plugin/plugin.json with kebab-case name
 *   - component paths relative, no '..', existing
 *   - valid frontmatter on every component (agents/commands/skills/rules:
 *     fail; rules must carry description + alwaysApply, no `paths:`, no
 *     `.claude/` references - phase 2 transform guarantees this)
 *   - no Claude model ids in agents (hard rule)
 *   - README.md present; all ${VAR}s used in mcp.json declared in variables
 * Exit 0 when there are no failures (warnings are reported but tolerated).
 */

const fs = require('fs');
const path = require('path');
const T = require('../lib/cursor-plugin/transforms');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PLUGIN_ROOT = path.join(REPO_ROOT, 'build', 'cursor-plugin', 'ecc-cursor');

const failures = [];
const warnings = [];
const fail = msg => failures.push(msg);

function listMd(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(ext)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function validateManifest() {
  const manifestPath = path.join(PLUGIN_ROOT, '.cursor-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    fail('.cursor-plugin/plugin.json missing (run build first)');
    return null;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    fail(`plugin.json is not valid JSON: ${err.message}`);
    return null;
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.name || '')) {
    fail(`plugin.json name must be kebab-case, got '${manifest.name}'`);
  }
  for (const key of ['rules', 'agents', 'skills', 'commands', 'hooks', 'mcpServers']) {
    const value = manifest[key];
    if (typeof value !== 'string' || !value) {
      fail(`plugin.json path '${key}' must be a non-empty relative path string`);
      continue;
    }
    if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
      fail(`plugin.json path '${key}' must be relative without '..': ${value}`);
      continue;
    }
    if (!fs.existsSync(path.join(PLUGIN_ROOT, value))) {
      fail(`plugin.json path '${key}' does not exist in the build: ${value}`);
    }
  }
  return manifest;
}

function validateAgents() {
  let count = 0;
  for (const file of listMd(path.join(PLUGIN_ROOT, 'agents'), '.md')) {
    count += 1;
    const content = fs.readFileSync(file, 'utf8');
    const fm = T.splitFrontmatter(content).frontmatter;
    const rel = path.relative(PLUGIN_ROOT, file);
    if (!fm) {
      fail(`agent without frontmatter: ${rel}`);
      continue;
    }
    const name = T.getFrontmatterField(fm, 'name');
    if (!name) fail(`agent without name: ${rel}`);
    // phase 3: plugin agents are ecc-<id>; file name must equal the agent name
    const fileBase = path.basename(file, '.md');
    if (name && name !== fileBase) fail(`agent name '${name}' != filename '${fileBase}': ${rel}`);
    if (name && !name.startsWith('ecc-')) fail(`agent name without ecc- prefix: ${rel}`);
    if (!T.getFrontmatterField(fm, 'description')) fail(`agent without description: ${rel}`);
    if (T.hasForbiddenModel(content)) {
      fail(`agent with Claude model id: ${rel} (must be 'model: inherit')`);
    }
    const model = T.getFrontmatterField(fm, 'model');
    if (model !== 'inherit') fail(`agent model must be 'inherit': ${rel}`);
    // Cursor subagent frontmatter allowlist (cursor.com/docs/subagents):
    // name, description, model, readonly, is_background
    if (/^tools:/m.test(fm)) fail(`agent still has a tools: allowlist (unsupported in Cursor): ${rel}`);
    if (/^color:/m.test(fm)) fail(`agent still has color: (Claude-only): ${rel}`);
    const readonly = T.getFrontmatterField(fm, 'readonly');
    if (readonly !== null && readonly !== 'true' && readonly !== 'false') {
      fail(`agent readonly must be true/false: ${rel}`);
    }
  }
  return count;
}

function validateCommands() {
  let count = 0;
  for (const file of listMd(path.join(PLUGIN_ROOT, 'commands'), '.md')) {
    count += 1;
    const content = fs.readFileSync(file, 'utf8');
    const fm = T.splitFrontmatter(content).frontmatter;
    const rel = path.relative(PLUGIN_ROOT, file);
    if (!fm || !T.getFrontmatterField(fm, 'description')) {
      fail(`command without frontmatter description: ${rel}`);
    }
  }
  return count;
}

function validateSkills() {
  let count = 0;
  const skillsRoot = path.join(PLUGIN_ROOT, 'skills');
  if (!fs.existsSync(skillsRoot)) return 0;
  for (const e of fs.readdirSync(skillsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    count += 1;
    const skillFile = path.join(skillsRoot, e.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      fail(`skill without SKILL.md: skills/${e.name}`);
      continue;
    }
    const fm = T.splitFrontmatter(fs.readFileSync(skillFile, 'utf8')).frontmatter;
    const name = T.getFrontmatterField(fm, 'name');
    if (!name) {
      fail(`skill without name in frontmatter: skills/${e.name}`);
    } else if (name !== e.name) {
      fail(`skill name '${name}' != folder '${e.name}'`);
    }
  }
  return count;
}

function validateRules() {
  let count = 0;
  for (const file of listMd(path.join(PLUGIN_ROOT, 'rules'), '.mdc')) {
    count += 1;
    const content = fs.readFileSync(file, 'utf8');
    const rel = path.relative(PLUGIN_ROOT, file);
    const fm = T.splitFrontmatter(content).frontmatter;
    if (!fm) {
      fail(`rule without frontmatter: ${rel}`);
      continue;
    }
    if (!T.getFrontmatterField(fm, 'description')) fail(`rule without description: ${rel}`);
    if (T.getFrontmatterField(fm, 'alwaysApply') === null) fail(`rule without alwaysApply: ${rel}`);
    if (T.getFrontmatterField(fm, 'alwaysApply') === 'false' && !/^globs:/m.test(fm)) {
      fail(`rule with alwaysApply: false but no globs: ${rel}`);
    }
    if (/^paths:/m.test(fm)) fail(`rule still has Claude-style paths: ${rel}`);
    if (content.includes('.claude/')) fail(`rule references .claude/: ${rel}`);
  }
  return count;
}

function validateMcp(manifest) {
  const mcpPath = path.join(PLUGIN_ROOT, 'mcp.json');
  if (!fs.existsSync(mcpPath)) return;
  const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
  const declared = new Set(Object.keys((manifest && manifest.variables) || {}));
  const varRe = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
  const text = JSON.stringify(mcp);
  let m;
  while ((m = varRe.exec(text)) !== null) {
    const name = m[1];
    if (name === 'CURSOR_PLUGIN_ROOT' || name === 'CLAUDE_PLUGIN_ROOT') continue;
    if (!declared.has(name)) {
      fail(`mcp.json uses \${${name}} but plugin.json declares no such variable`);
    }
  }
}

if (require.main === module) {
  const manifest = validateManifest();
  if (!fs.existsSync(path.join(PLUGIN_ROOT, 'README.md'))) fail('README.md missing');
  if (!fs.existsSync(path.join(PLUGIN_ROOT, 'LICENSE'))) fail('LICENSE missing');
  const counts = {
    agents: validateAgents(),
    commands: validateCommands(),
    skills: validateSkills(),
    rules: validateRules(),
  };
  if (manifest) validateMcp(manifest);

  console.log(`ecc-cursor validate: agents ${counts.agents}, commands ${counts.commands}, skills ${counts.skills}, rules ${counts.rules}`);
  for (const w of warnings) console.log(`  WARN: ${w}`);
  for (const f of failures) console.error(`  FAIL: ${f}`);
  if (failures.length > 0) {
    console.error(`validate FAILED: ${failures.length} failure(s), ${warnings.length} warning(s)`);
    process.exit(1);
  }
  console.log(`validate OK (${warnings.length} warning(s))`);
}

module.exports = { validateManifest };
