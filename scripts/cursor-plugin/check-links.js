#!/usr/bin/env node
'use strict';

/**
 * Link integrity checker for the ecc-cursor build (phase 3: warn mode).
 *
 * Scans every markdown component of the built plugin and reports references
 * to agents / skills / commands / rules / scripts that exist in the upstream
 * repo but are MISSING from the build (broken by exclusion or not yet
 * transformed). Prints a baseline summary by link type; exit code is always
 * 0 unless --fail is passed (fail mode arrives with phase 5).
 *
 * Agent references resolve through cursor-plugin/maps/agent-names.json
 * (phase 3): built agents are `ecc-<id>`, so a bare token resolves iff its
 * mapped ecc-* name is built (bare names survive in skills/commands until
 * phases 4-5), and an `ecc-<id>` token resolves iff that exact agent is
 * built (catches typos in renamed references).
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
const SLASH_REF_RE = /(?:^|[\s`"(])\/([a-z][a-z0-9-]{1,40})\b/gm;
// Rule references: upstream form rules/<ns>/<file>.md (resolves to the
// flattened <ns>-<file> name) and built form rules/<ns>-<file>.mdc.
// Lookbehind boundary: a preceding '/' is fine (../../rules/... links).
const RULE_NS_REF_RE = /(?<![\w-])rules\/([\w-]+)\/([\w-]+)\.md\b/gm;
const RULE_FLAT_REF_RE = /(?<![\w-])rules\/([\w-]+)\.mdc\b/gm;

function scanTokenRefs(tokens, file, ctx) {
  for (const name of ctx.repoAgents) {
    // bare reference (pre-rename form): resolves iff the mapped ecc-* agent is built
    if (tokens.has(name) && !ctx.builtAgents.has(ctx.agentNameMap[name])) ctx.add('agents', name, file);
  }
  for (const eccName of ctx.eccAgentNames) {
    // renamed reference: resolves iff that exact agent is built
    if (tokens.has(eccName) && !ctx.builtAgents.has(eccName)) ctx.add('agents', eccName, file);
  }
  for (const name of ctx.repoSkills) {
    if (tokens.has(name) && !ctx.builtSkills.has(name)) ctx.add('skills', name, file);
  }
  for (const name of ctx.repoCommands) {
    if (tokens.has(name) && !ctx.builtCommands.has(name)) ctx.add('commands', name, file);
  }
}

function scanPathRefs(content, file, ctx) {
  let m;
  SCRIPT_REF_RE.lastIndex = 0;
  while ((m = SCRIPT_REF_RE.exec(content)) !== null) {
    let ref = m[1];
    if (ref.startsWith('./')) ref = ref.slice(2);
    if (ref.startsWith('../')) continue;
    if (!ctx.builtScripts.has(ref)) ctx.add('scripts', ref, file);
  }

  SLASH_REF_RE.lastIndex = 0;
  while ((m = SLASH_REF_RE.exec(content)) !== null) {
    const name = m[1];
    if (ctx.repoCommands.has(name) && !ctx.builtCommands.has(name)) ctx.add('commands', `/${name}`, file);
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
  const repoAgents = namesOf(path.join(REPO_ROOT, 'agents'), f => f.endsWith('.md') && f.slice(0, -3));
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
  const scanCtx = { repoAgents, repoSkills, repoCommands, builtAgents, builtSkills, builtCommands, builtRules, builtScripts, agentNameMap, eccAgentNames, add };
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
  const failMode = process.argv.includes('--fail');
  const { broken, summary, total } = checkLinks();
  console.log('ecc-cursor check-links (warn mode' + (failMode ? ', --fail' : '') + ')');
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
  if (failMode && total > 0) process.exit(1);
}

module.exports = { checkLinks };
