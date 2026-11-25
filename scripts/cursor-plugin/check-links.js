#!/usr/bin/env node
'use strict';

/**
 * Link integrity checker for the ecc-cursor build (phase 5: fail mode).
 *
 * Scans every markdown component of the built plugin and reports references
 * to agents / skills / commands / rules / scripts that exist in the upstream
 * repo but are MISSING from the build. Exit code is 1 when any target is
 * broken. Pass --warn to keep the phase-1..4 exit-0 behaviour.
 *
 * Agent references are ecc-<id> only. Bare names are prose: the skill and
 * command transforms rename real references, so a bare token is not a link.
 * An ecc-<id> token resolves iff that exact agent is built.
 *
 * A command stem that collides with a skill is shipped as ecc-<stem>. A
 * remaining /<stem> or bare <stem> token is the skill, which still exists,
 * and is not reported. A slash or token that matches neither the built
 * command, the renamed command, nor a built skill is broken.
 */

const fs = require('fs');
const path = require('path');
const T = require('../lib/cursor-plugin/transforms');
const { loadAgentNameMap } = require('../lib/cursor-plugin/agent-names');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PLUGIN_ROOT = path.join(REPO_ROOT, 'build', 'cursor-plugin', 'ecc-cursor');

function namesOf(dir, map) {
  if (!fs.existsSync(dir)) return new Set();
  return new Set(fs.readdirSync(dir).map(map).filter(Boolean));
}

function collectMarkdown(root) {
  const out = [];
  const walk = d => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && /\.(md|mdc)$/.test(e.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

function tokenize(content) {
  return new Set(content.split(/[^a-z0-9-]+/i).filter(Boolean));
}

const SCRIPT_REF_RE = /(?:^|[\s"'`(=])((?:\.{1,2}\/)?scripts\/[\w@+.,~/-]+\.(?:js|cjs|mjs|py|sh))\b/gm;
const PLUGIN_SKILL_SCRIPT_RE = /\$ECC_PLUGIN_ROOT\/skills\/([a-z0-9-]+)\/(scripts\/[\w@+.,~/-]+\.(?:js|cjs|mjs|py|sh))/g;
const SLASH_REF_RE = /(?:^|[\s`"(])\/([a-z][a-z0-9-]{1,40})\b/gm;
// Rule references: upstream form rules/<ns>/<file>.md (resolves to the
// flattened <ns>-<file> name) and built form rules/<ns>-<file>.mdc.
// Lookbehind boundary: a preceding '/' is fine (../../rules/... links).
const RULE_NS_REF_RE = /(?<![\w-])rules\/([\w-]+)\/([\w-]+)\.md\b/gm;
const RULE_FLAT_REF_RE = /(?<![\w-])rules\/([\w-]+)\.mdc\b/gm;

function commandRenamedToSkill(name, ctx) {
  return ctx.builtSkills.has(name) && ctx.builtCommands.has(`ecc-${name}`);
}

function scanTokenRefs(tokens, file, ctx) {
  for (const eccName of ctx.eccAgentNames) {
    if (tokens.has(eccName) && !ctx.builtAgents.has(eccName)) ctx.add('agents', eccName, file);
  }
  for (const name of ctx.repoSkills) {
    if (tokens.has(name) && !ctx.builtSkills.has(name)) ctx.add('skills', name, file);
  }
  for (const name of ctx.repoCommands) {
    if (!tokens.has(name) || ctx.builtCommands.has(name)) continue;
    if (commandRenamedToSkill(name, ctx)) continue;
    ctx.add('commands', name, file);
  }
}

function scanPathRefs(content, file, ctx) {
  let m;
  SCRIPT_REF_RE.lastIndex = 0;
  while ((m = SCRIPT_REF_RE.exec(content)) !== null) {
    let ref = m[1];
    if (ref.startsWith('./')) ref = ref.slice(2);
    if (ref.startsWith('../')) continue;
    if (ctx.builtScripts.has(ref)) continue;
    // intra-skill reference: skills/<name>/ often ships its own scripts/
    // directory (e.g. story-lifecycle/scripts/ledger.js); phase 4 resolves
    // these against the skill folder before calling the link broken.
    const rel = T.toPosix(path.relative(PLUGIN_ROOT, file));
    if (rel.startsWith('skills/')) {
      const skillName = rel.split('/')[1];
      if (fs.existsSync(path.join(PLUGIN_ROOT, 'skills', skillName, ref))) continue;
    }
    ctx.add('scripts', ref, file);
  }

  const relFile = T.toPosix(path.relative(PLUGIN_ROOT, file));
  const inCommands = relFile.startsWith('commands/');
  SLASH_REF_RE.lastIndex = 0;
  while ((m = SLASH_REF_RE.exec(content)) !== null) {
    const name = m[1];
    if (!ctx.repoCommands.has(name) || ctx.builtCommands.has(name)) continue;
    // Inside commands, a collision slash (/plan-canvas, /ecc-guide) must
    // already have been rewritten to the plugin command name.
    if (inCommands && ctx.builtCommands.has(`ecc-${name}`)) {
      ctx.add('commands', `/${name}`, file);
      continue;
    }
    if (commandRenamedToSkill(name, ctx)) continue;
    ctx.add('commands', `/${name}`, file);
  }

  PLUGIN_SKILL_SCRIPT_RE.lastIndex = 0;
  while ((m = PLUGIN_SKILL_SCRIPT_RE.exec(content)) !== null) {
    const skill = m[1];
    const relScript = m[2];
    if (!ctx.builtSkills.has(skill)) {
      ctx.add('skills', skill, file);
      continue;
    }
    if (!fs.existsSync(path.join(PLUGIN_ROOT, 'skills', skill, relScript))) {
      ctx.add('scripts', `$ECC_PLUGIN_ROOT/skills/${skill}/${relScript}`, file);
    }
  }

  RULE_NS_REF_RE.lastIndex = 0;
  while ((m = RULE_NS_REF_RE.exec(content)) !== null) {
    const flat = `${m[1]}-${m[2]}`;
    if (!ctx.builtRules.has(flat)) ctx.add('rules', `rules/${m[1]}/${m[2]}.md`, file);
  }
  RULE_FLAT_REF_RE.lastIndex = 0;
  while ((m = RULE_FLAT_REF_RE.exec(content)) !== null) {
    if (!ctx.builtRules.has(m[1])) ctx.add('rules', `rules/${m[1]}.mdc`, file);
  }
}

function scanMarkdownFile(file, ctx) {
  const content = fs.readFileSync(file, 'utf8');
  scanTokenRefs(tokenize(content), file, ctx);
  scanPathRefs(content, file, ctx);
}

function checkLinks() {
  // Name spaces from the UPSTREAM repo (what a reference could mean)...
  const repoSkills = new Set(fs.readdirSync(path.join(REPO_ROOT, 'skills'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name));
  const repoCommands = namesOf(path.join(REPO_ROOT, 'commands'), f => f.endsWith('.md') && f.slice(0, -3));

  // ...and what the BUILD actually contains.
  const builtAgents = namesOf(path.join(PLUGIN_ROOT, 'agents'), f => f.endsWith('.md') && f.slice(0, -3));
  const builtSkills = new Set(fs.readdirSync(path.join(PLUGIN_ROOT, 'skills'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name));
  const builtCommands = namesOf(path.join(PLUGIN_ROOT, 'commands'), f => f.endsWith('.md') && f.slice(0, -3));
  const builtRules = namesOf(path.join(PLUGIN_ROOT, 'rules'), f => f.endsWith('.mdc') && f.slice(0, -4));
  const builtScripts = new Set();
  const scriptsRoot = path.join(PLUGIN_ROOT, 'scripts');
  const walkScripts = d => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walkScripts(full);
      else if (e.isFile()) builtScripts.add(T.toPosix(path.relative(PLUGIN_ROOT, full)));
    }
  };
  walkScripts(scriptsRoot);

  const broken = { agents: new Map(), skills: new Map(), commands: new Map(), rules: new Map(), scripts: new Map() };
  const add = (type, name, from) => {
    const rel = T.toPosix(path.relative(PLUGIN_ROOT, from));
    if (!broken[type].has(name)) broken[type].set(name, new Set());
    broken[type].get(name).add(rel);
  };

  const agentNameMap = loadAgentNameMap(REPO_ROOT);
  const eccAgentNames = new Set(Object.values(agentNameMap));
  const scanCtx = { repoSkills, repoCommands, builtAgents, builtSkills, builtCommands, builtRules, builtScripts, eccAgentNames, add };
  for (const file of collectMarkdown(PLUGIN_ROOT)) {
    scanMarkdownFile(file, scanCtx);
  }

  const summary = {};
  let total = 0;
  for (const [type, map] of Object.entries(broken)) {
    summary[type] = { targets: map.size, references: [...map.values()].reduce((n, s) => n + s.size, 0) };
    total += map.size;
  }
  return { broken, summary, total };
}

if (require.main === module) {
  const warnMode = process.argv.includes('--warn');
  const { broken, summary, total } = checkLinks();
  console.log(`ecc-cursor check-links (${warnMode ? 'warn' : 'fail'} mode)`);
  for (const [type, s] of Object.entries(summary)) {
    console.log(`  ${type.padEnd(9)} broken targets: ${String(s.targets).padStart(4)}, reference sites: ${s.references}`);
  }
  const show = (type, limit) => {
    const entries = [...broken[type].entries()].sort((a, b) => b[1].size - a[1].size).slice(0, limit);
    for (const [name, files] of entries) {
      const sample = [...files].sort().slice(0, 2).join(', ');
      console.log(`    ${type}: ${name}  <- ${files.size} file(s): ${sample}${files.size > 2 ? ', ...' : ''}`);
    }
  };
  for (const type of ['skills', 'agents', 'commands', 'rules', 'scripts']) show(type, 8);
  console.log(`  total broken targets: ${total}`);
  if (!warnMode && total > 0) process.exit(1);
}

module.exports = { checkLinks };
