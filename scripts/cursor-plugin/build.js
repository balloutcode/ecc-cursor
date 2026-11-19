#!/usr/bin/env node
'use strict';

/**
 * ecc-cursor plugin builder (phase 1: identity build).
 *
 * Reads upstream ECC sources (never modifies them), applies the phase-1
 * transform set (identity + agent `model: inherit`), and writes a ready
 * Cursor plugin to build/cursor-plugin/ecc-cursor/ plus a build report to
 * build/cursor-plugin/report.json.
 *
 * Composition: `full` install profile (36 modules, manifests/install-*.json)
 * minus cursor-plugin/maps/exclusions.json, with target overrides from
 * cursor-plugin/maps/module-target-overrides.json applied in our layer only.
 *
 * Runtime scripts are the require-closure of four graph roots, not a list:
 *   (1) plugin hook entry points (cursor-plugin/hooks-src)
 *   (2) node scripts referenced by included skills
 *   (3) node scripts referenced by included commands
 *   (4) node scripts referenced by included agents
 *
 * Deterministic: two runs on the same tree produce byte-identical output
 * (sorted operations, no timestamps/random in report.json).
 */

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const T = require('../lib/cursor-plugin/transforms');
const { generateHooksJson, loadHookMap, serialize } = require('./generate-hooks');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LAYER_ROOT = path.join(REPO_ROOT, 'cursor-plugin');
const OUT_ROOT = path.join(REPO_ROOT, 'build', 'cursor-plugin', 'ecc-cursor');
const REPORT_PATH = path.join(REPO_ROOT, 'build', 'cursor-plugin', 'report.json');

const MCP_ALLOWLIST = ['chrome-devtools'];
const BUILTINS = new Set([...builtinModules, ...builtinModules.map(m => `node:${m}`)]);

// ---------------------------------------------------------------------------
// helpers

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
}

function listFilesRecursive(absDir) {
  const out = [];
  if (!fs.existsSync(absDir)) return out;
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(T.toPosix(path.relative(absDir, full)));
    }
  };
  walk(absDir);
  return out.sort();
}

function createOp(srcAbs, destRel, transform) {
  return { srcAbs, destRel: T.toPosix(destRel), transform: transform || null };
}

// ---------------------------------------------------------------------------
// composition: full profile + overrides - exclusions

function resolveComposition() {
  const profiles = readJson('manifests/install-profiles.json');
  const modules = readJson('manifests/install-modules.json').modules;
  const overrides = readJson('cursor-plugin/maps/module-target-overrides.json').overrides || {};
  const fullModules = profiles.profiles.full.modules;

  const byId = new Map(modules.map(m => [m.id, m]));
  const skillSet = new Set();
  for (const id of fullModules) {
    const mod = byId.get(id);
    if (!mod) continue;
    for (const p of mod.paths || []) {
      if (p.startsWith('skills/')) skillSet.add(p.slice('skills/'.length));
    }
  }
  const notInProfile = modules.map(m => m.id).filter(id => !fullModules.includes(id)).sort();
  return { fullModules: [...fullModules].sort(), notInProfile, skillSet, overrides };
}

// ---------------------------------------------------------------------------
// collectors (each returns ops + report data)

function collectRules(warnings) {
  const ops = [];
  const skipped = [];
  const rulesRoot = path.join(REPO_ROOT, 'rules');
  const entries = fs.readdirSync(rulesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  let withoutFrontmatter = 0;
  for (const entry of entries) {
    if (entry.isFile()) {
      skipped.push({ path: `rules/${entry.name}`, reason: 'documentation file, not a rule' });
      continue;
    }
    if (!entry.isDirectory()) continue;
    for (const rel of listFilesRecursive(path.join(rulesRoot, entry.name))) {
      const flat = T.flattenRuleName(entry.name, rel);
      if (!flat) {
        skipped.push({ path: `rules/${entry.name}/${rel}`, reason: 'README, not a rule' });
        continue;
      }
      const content = fs.readFileSync(path.join(rulesRoot, entry.name, rel), 'utf8');
      if (!T.splitFrontmatter(content).frontmatter) withoutFrontmatter += 1;
      ops.push(createOp(path.join(rulesRoot, entry.name, rel), path.join('rules', flat)));
    }
  }
  if (withoutFrontmatter > 0) {
    warnings.push(`rules: ${withoutFrontmatter} files without frontmatter (identity build; phase 2 adds globs/alwaysApply)`);
  }
  return { ops, skipped };
}

function collectAgents(warnings) {
  const ops = [];
  const agentsRoot = path.join(REPO_ROOT, 'agents');
  const modelStats = {};
  for (const f of fs.readdirSync(agentsRoot).filter(f => f.endsWith('.md')).sort()) {
    const content = fs.readFileSync(path.join(agentsRoot, f), 'utf8');
    const fm = T.splitFrontmatter(content).frontmatter;
    const model = T.getFrontmatterField(fm, 'model');
    modelStats[model || '(none)'] = (modelStats[model || '(none)'] || 0) + 1;
    if (!model) warnings.push(`agents: ${f} has no model field (left as-is)`);
    ops.push(createOp(path.join(agentsRoot, f), path.join('agents', f), T.agentModelInherit));
  }
  return { ops, modelStats };
}

function collectSkills(skillSet, exclusions) {
  const ops = [];
  const skipped = [];
  const included = [...skillSet].filter(s => !exclusions.skills[s]).sort();
  for (const name of Object.keys(exclusions.skills).sort()) {
    if (skillSet.has(name)) skipped.push({ path: `skills/${name}`, reason: exclusions.skills[name] });
  }
  for (const name of included) {
    const skillDir = path.join(REPO_ROOT, 'skills', name);
    for (const rel of listFilesRecursive(skillDir)) {
      ops.push(createOp(path.join(skillDir, rel), path.join('skills', name, rel)));
    }
  }
  return { ops, skipped, included };
}

function collectCommands() {
  const ops = [];
  const commandsRoot = path.join(REPO_ROOT, 'commands');
  for (const f of fs.readdirSync(commandsRoot).filter(f => f.endsWith('.md')).sort()) {
    ops.push(createOp(path.join(commandsRoot, f), path.join('commands', f)));
  }
  const overrideRoot = path.join(LAYER_ROOT, 'overrides', 'commands');
  const overrideNames = [];
  if (fs.existsSync(overrideRoot)) {
    for (const f of fs.readdirSync(overrideRoot).filter(f => f.endsWith('.md')).sort()) {
      if (ops.some(o => o.destRel === `commands/${f}`)) {
        throw new Error(`override command collides with upstream command: ${f}`);
      }
      ops.push(createOp(path.join(overrideRoot, f), path.join('commands', f)));
      overrideNames.push(f);
    }
  }
  return { ops, upstreamCount: ops.length - overrideNames.length, overrideNames };
}

function collectHooks(hookMap) {
  const ops = [];
  const hooksSrc = path.join(LAYER_ROOT, 'hooks-src');
  for (const f of fs.readdirSync(hooksSrc).filter(f => f.endsWith('.js')).sort()) {
    ops.push(createOp(path.join(hooksSrc, f), path.join('hooks', f)));
  }
  const hooksJson = serialize(generateHooksJson(hookMap));
  return { ops, hooksJson };
}

// ---------------------------------------------------------------------------
// script require-closure

const SCRIPT_REF_RE = /(?:^|[\s"'`(=])((?:\.{1,2}\/)?scripts\/[\w@+.,~/-]+\.(?:js|cjs|mjs))\b/gm;
const REQUIRE_RE = /require\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

function extractScriptRefs(content) {
  const refs = new Set();
  let m;
  SCRIPT_REF_RE.lastIndex = 0;
  while ((m = SCRIPT_REF_RE.exec(content)) !== null) {
    let ref = m[1];
    if (ref.startsWith('./')) ref = ref.slice(2);
    if (ref.startsWith('../')) continue; // outside repo root references are not seeds
    refs.add(ref);
  }
  return refs;
}

function resolveRequire(fromFile, spec) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null; // package or builtin
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}.json`, path.join(base, 'index.js')];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function exclusionMatcher(scriptPatterns) {
  const regexes = Object.keys(scriptPatterns).map(pattern => ({
    pattern,
    reason: scriptPatterns[pattern],
    re: new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`),
  }));
  return rel => regexes.find(r => r.re.test(rel)) || null;
}

function collectScripts(seedFiles, warnings, exclusions) {
  const scriptsRoot = path.join(REPO_ROOT, 'scripts');
  const included = new Map(); // absPath -> rel posix under scripts/
  const externalDeps = new Set();
  const skipped = [];
  const matchesExclusion = exclusionMatcher(exclusions.scripts || {});
  const queue = [];
  const walked = new Set();

  const enqueue = abs => {
    if (walked.has(abs)) return;
    walked.add(abs);
    const relRepo = T.toPosix(path.relative(REPO_ROOT, abs));
    if (relRepo === 'package.json') {
      // version reads (plan-canvas.js, terminal-welcome.js) resolve to the
      // plugin root - harmless, ship it.
      included.set(abs, 'package.json');
      queue.push(abs);
      return;
    }
    if (relRepo.startsWith('cursor-plugin/')) {
      // hook entry points are already shipped under hooks/; still walk their
      // requires so phase-6 dispatcher dependencies are bundled.
      queue.push(abs);
      return;
    }
    const rel = T.toPosix(path.relative(scriptsRoot, abs));
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      warnings.push(`script outside scripts/ is not bundled: ${relRepo}`);
      return;
    }
    const excluded = matchesExclusion(`scripts/${rel}`);
    if (excluded) {
      skipped.push({ path: `scripts/${rel}`, reason: `excluded: ${excluded.reason}` });
      return;
    }
    if (included.has(abs)) return;
    included.set(abs, rel);
    queue.push(abs);
  };

  for (const seed of seedFiles) {
    if (fs.existsSync(seed)) enqueue(seed);
  }

  while (queue.length) {
    const file = queue.shift();
    if (!/\.(js|cjs|mjs)$/.test(file)) continue; // .json and assets: copied, not parsed
    const content = fs.readFileSync(file, 'utf8');
    let m;
    REQUIRE_RE.lastIndex = 0;
    while ((m = REQUIRE_RE.exec(content)) !== null) {
      const spec = m[1];
      if (!spec.startsWith('./') && !spec.startsWith('../')) {
        const pkg = spec.startsWith('node:') ? spec : spec.split('/')[0];
        if (!BUILTINS.has(spec) && !BUILTINS.has(pkg)) externalDeps.add(pkg);
        continue;
      }
      const resolved = resolveRequire(file, spec);
      if (!resolved) {
        warnings.push(`unresolved require '${spec}' in ${T.toPosix(path.relative(REPO_ROOT, file))}`);
        continue;
      }
      enqueue(resolved);
    }
  }

  const ops = [...included.entries()]
    .map(([abs, rel]) => createOp(abs, rel === 'package.json' ? 'package.json' : path.join('scripts', rel)))
    .sort((a, b) => a.destRel.localeCompare(b.destRel));
  return { ops, files: [...included.values()].sort(), externalDeps: [...externalDeps].sort(), skipped };
}

// ---------------------------------------------------------------------------
// main build

function build() {
  const exclusions = readJson('cursor-plugin/maps/exclusions.json');
  const hookMap = loadHookMap();
  const template = readJson('cursor-plugin/plugin.template.json');
  const composition = resolveComposition();

  const warnings = [];
  const skipped = [];

  const rules = collectRules(warnings);
  const agents = collectAgents(warnings);
  const skills = collectSkills(composition.skillSet, exclusions);
  const commands = collectCommands();
  const hooks = collectHooks(hookMap);
  skipped.push(...rules.skipped, ...skills.skipped);

  // script refs from included markdown (roots 2-4) + hook entry points (root 1)
  const seedFiles = new Set();
  for (const op of [...skills.ops, ...commands.ops]) {
    if (!op.srcAbs.endsWith('.md')) continue;
    for (const ref of extractScriptRefs(fs.readFileSync(op.srcAbs, 'utf8'))) {
      seedFiles.add(path.join(REPO_ROOT, ref));
    }
  }
  for (const f of fs.readdirSync(path.join(REPO_ROOT, 'agents')).filter(f => f.endsWith('.md')).sort()) {
    for (const ref of extractScriptRefs(fs.readFileSync(path.join(REPO_ROOT, 'agents', f), 'utf8'))) {
      seedFiles.add(path.join(REPO_ROOT, ref));
    }
  }
  for (const op of hooks.ops) seedFiles.add(op.srcAbs);
  const seedList = [...seedFiles]
    .map(f => T.toPosix(path.relative(REPO_ROOT, f)))
    .sort();

  const scripts = collectScripts([...seedFiles], warnings, exclusions);
  skipped.push(...scripts.skipped);

  // mcp.json (allowlist only, zero secrets)
  const mcpSrc = readJson('.mcp.json');
  const mcpServers = {};
  for (const name of MCP_ALLOWLIST) {
    if (mcpSrc.mcpServers && mcpSrc.mcpServers[name]) mcpServers[name] = mcpSrc.mcpServers[name];
  }
  const mcpJson = `${JSON.stringify({ mcpServers }, null, 2)}\n`;

  // static files
  const staticOps = [
    createOp(path.join(REPO_ROOT, 'LICENSE'), 'LICENSE'),
    createOp(path.join(LAYER_ROOT, 'README.template.md'), 'README.md'),
    createOp(path.join(LAYER_ROOT, 'CHANGELOG.template.md'), 'CHANGELOG.md'),
    createOp(path.join(LAYER_ROOT, 'assets', 'logo.svg'), path.join('assets', 'logo.svg')),
  ];

  const allOps = [...rules.ops, ...agents.ops, ...skills.ops, ...commands.ops, ...hooks.ops, ...scripts.ops, ...staticOps]
    .sort((a, b) => a.destRel.localeCompare(b.destRel));

  // write
  fs.rmSync(OUT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  let bytes = 0;
  for (const op of allOps) {
    const dest = path.join(OUT_ROOT, op.destRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const content = op.transform ? op.transform(fs.readFileSync(op.srcAbs, 'utf8')) : fs.readFileSync(op.srcAbs);
    fs.writeFileSync(dest, content);
    bytes += typeof content === 'string' ? Buffer.byteLength(content) : content.length;
  }
  const writeRaw = (rel, content) => {
    const dest = path.join(OUT_ROOT, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
    bytes += Buffer.byteLength(content);
  };
  writeRaw(path.join('.cursor-plugin', 'plugin.json'), `${JSON.stringify(template, null, 2)}\n`);
  writeRaw(path.join('hooks', 'hooks.json'), hooks.hooksJson);
  writeRaw('mcp.json', mcpJson);

  const totalFiles = allOps.length + 3;
  const hookEvents = new Set((hookMap.probes || []).map(p => p.event)).size;
  const hookEntries = (hookMap.probes || []).length * 2 + (hookMap.entries || []).length;

  const platformDirsPresent = Object.keys(exclusions.platformDirs)
    .filter(d => fs.existsSync(path.join(REPO_ROOT, d)))
    .sort();

  const report = {
    phase: 1,
    profile: 'full',
    modules: {
      included: composition.fullModules,
      notInProfile: composition.notInProfile,
      targetOverrides: Object.fromEntries(Object.entries(composition.overrides).map(([k, v]) => [k, { addTargets: v.addTargets || [] }])),
    },
    counts: {
      rules: rules.ops.length,
      agents: agents.ops.length,
      skills: skills.included.length,
      commands: { upstream: commands.upstreamCount, overrides: commands.overrideNames.length, total: commands.ops.length },
      hooks: { events: hookEvents, entries: hookEntries },
      scripts: scripts.files.length,
      files: totalFiles,
      bytes,
    },
    agentModelStats: agents.modelStats,
    excluded: {
      skills: Object.fromEntries(Object.entries(exclusions.skills).sort((a, b) => a[0].localeCompare(b[0]))),
      platformDirsPresent,
      scripts: Object.keys(exclusions.scripts).sort(),
    },
    skipped: skipped.sort((a, b) => a.path.localeCompare(b.path)),
    scriptClosure: {
      roots: ['hooks entry points', 'skill markdown refs', 'command markdown refs', 'agent markdown refs'],
      seeds: seedList,
      files: scripts.files,
      externalDeps: scripts.externalDeps,
    },
    warnings: warnings.sort(),
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

if (require.main === module) {
  const report = build();
  const c = report.counts;
  console.log('ecc-cursor build OK (phase 1, identity)');
  console.log(`  rules:    ${c.rules}`);
  console.log(`  agents:   ${c.agents}`);
  console.log(`  skills:   ${c.skills}`);
  console.log(`  commands: ${c.commands.total} (upstream ${c.commands.upstream} + overrides ${c.commands.overrides})`);
  console.log(`  hooks:    ${c.hooks.events} events, ${c.hooks.entries} entries`);
  console.log(`  scripts:  ${c.scripts} (require-closure, ${report.scriptClosure.seeds.length} seeds)`);
  console.log(`  files:    ${c.files}, ${(c.bytes / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`  warnings: ${report.warnings.length}`);
  console.log(`  -> ${path.relative(REPO_ROOT, OUT_ROOT)}`);
  console.log(`  report -> ${path.relative(REPO_ROOT, REPORT_PATH)}`);
}

module.exports = { build, extractScriptRefs, OUT_ROOT, REPORT_PATH, REPO_ROOT };
