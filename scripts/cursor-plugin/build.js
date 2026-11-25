#!/usr/bin/env node
'use strict';

/**
 * ecc-cursor plugin builder (phase 5: commands).
 *
 * Reads upstream ECC sources (never modifies them), applies the transform
 * set (rules: paths->globs + native .cursor/rules copies + link fixes +
 * agent refs -> ecc-*; agents: agent-emit-cursor.js - name ecc-<id>,
 * model inherit, readonly for the 11 strict tool sets, tools list restated
 * in the body; skills: frontmatter allowlist + paths for language skills,
 * path-map rewrites, agent refs -> ecc-*, mcp__ neutralization, $ARGUMENTS,
 * tool tokens; contexts: ecc-context-* skills; commands: name +
 * description, $ARGUMENTS block, skill-name collisions prefixed ecc-,
 * codeagent-wrapper commands replaced with subagent bodies; markdown:
 * rules/<ns>/<f>.md -> rules/<ns>-<f>.mdc references), and writes a ready
 * Cursor plugin to build/cursor-plugin/ecc-cursor/ plus a build report to
 * build/cursor-plugin/report.json. Also regenerates
 * cursor-plugin/maps/agent-names.json (deterministic; phases 4-5 consume it).
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
const R = require('../lib/cursor-plugin/rules');
const E = require('../lib/cursor-plugin/agent-emit-cursor');
const N = require('../lib/cursor-plugin/agent-names');
const S = require('../lib/cursor-plugin/skills');
const C = require('../lib/cursor-plugin/commands');
const { createAgentRefTransform } = require('../lib/cursor-plugin/agent-refs');
const { parseAllAgents } = require('../lib/agent-ir');
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

function collectRules(warnings, agentRefs) {
  const ops = [];
  const skipped = [];
  const rulesRoot = path.join(REPO_ROOT, 'rules');
  const nativeRules = R.listNativeRules(REPO_ROOT);
  const usedNative = new Set();
  const stats = { total: 0, native: 0, upstream: 0, alwaysApplyTrue: 0, withGlobs: 0, withoutSourceFrontmatter: 0, renamedAgentRefs: 0, renamedAgentRefsStructured: 0 };
  const seen = new Map(); // destRel -> source path (collision guard)
  const entries = fs.readdirSync(rulesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
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
      const srcAbs = path.join(rulesRoot, entry.name, rel);
      const destRel = path.join('rules', flat);
      const prev = seen.get(destRel);
      if (prev) {
        throw new Error(`rule name collision: ${destRel} from rules/${entry.name}/${rel} and ${prev}`);
      }
      seen.set(destRel, `rules/${entry.name}/${rel}`);

      const flatName = flat.replace(/\.mdc$/, '');
      const nativePath = nativeRules.get(flatName) || null;
      const content = fs.readFileSync(srcAbs, 'utf8');
      const nativeContent = nativePath ? fs.readFileSync(nativePath, 'utf8') : null;
      const rendered = R.transformRule({ namespace: entry.name, relFile: rel, content, nativeContent, agentRefs });

      stats.total += 1;
      stats[rendered.meta.source] += 1;
      if (rendered.meta.alwaysApply) stats.alwaysApplyTrue += 1;
      if (rendered.meta.globs) stats.withGlobs += 1;
      if (nativePath) usedNative.add(flatName);
      if (!nativePath && rendered.meta.hadFrontmatter === false) stats.withoutSourceFrontmatter += 1;
      stats.renamedAgentRefs += rendered.meta.agentRefReplacements || 0;
      stats.renamedAgentRefsStructured += rendered.meta.agentRefStructured || 0;

      ops.push(createOp(srcAbs, destRel, () => rendered.content));
    }
  }
  const unmatchedNative = [...nativeRules.keys()].filter(n => !usedNative.has(n)).sort();
  if (unmatchedNative.length > 0) {
    warnings.push(`rules: ${unmatchedNative.length} native .cursor/rules copies match no upstream rule: ${unmatchedNative.join(', ')}`);
  }
  return { ops, skipped, stats };
}

function applyAgentOverrides(body, groups, agentId) {
  const lists = agentId
    ? [groups && groups[agentId]].filter(Boolean)
    : Object.values(groups || {});
  let out = body;
  for (const list of lists) {
    for (const ov of list) {
      if (!ov.match || !out.includes(ov.match)) continue;
      out = out.split(ov.match).join(ov.replace);
    }
  }
  return out;
}

function collectAgents(warnings, ruleRefs, agentRefs, nameMap, agentOverrides) {
  const irs = parseAllAgents(path.join(REPO_ROOT, 'agents'));
  let renamedRefs = 0;
  let structuredRefs = 0;
  const transformBody = (body, ir) => {
    const renamed = agentRefs(ruleRefs(applyAgentOverrides(body, agentOverrides, ir && ir.id)));
    renamedRefs += renamed.replacements;
    structuredRefs += renamed.structuredReplacements || 0;
    return T.stripClaudeModelPins(renamed.content);
  };
  const { results, warnings: emitWarnings, stats } = E.emitAllCursorAgents(irs, { nameMap, transformBody });
  warnings.push(...emitWarnings);
  const ops = results.map(r => createOp(
    path.join(REPO_ROOT, 'agents', `${r.id}.md`),
    path.join('agents', `${r.name}.md`),
    () => r.markdown
  ));
  return { ops, stats: { ...stats, renamedRefs, structuredRefs } };
}

function collectSkills(skillSet, exclusions, skillTransform) {
  const ops = [];
  const skipped = [];
  const included = [...skillSet].filter(s => !exclusions.skills[s]).sort();
  for (const name of Object.keys(exclusions.skills).sort()) {
    if (skillSet.has(name)) skipped.push({ path: `skills/${name}`, reason: exclusions.skills[name] });
  }
  const stats = {
    total: included.length,
    pathRewrites: 0,
    toolTokens: 0,
    overridesApplied: 0,
    droppedKeys: 0,
    allowedToolsRestated: 0,
    pathsAdded: 0,
    agentRefsRenamed: 0,
    agentRefsStructured: 0,
    mcpNeutralized: 0,
    argumentsRewritten: 0,
  };
  // op transforms run lazily at write time, so per-skill flags are collected
  // in sets (their sizes are read by the report after the write loop)
  const changedSkills = new Set();
  const pathSkills = new Set();
  for (const name of included) {
    const skillDir = path.join(REPO_ROOT, 'skills', name);
    for (const rel of listFilesRecursive(skillDir)) {
      const isMarkdown = rel.endsWith('.md');
      const transform = isMarkdown
        ? content => {
            const r = skillTransform(content, { skillName: name, isSkillMd: rel === 'SKILL.md' });
            stats.pathRewrites += r.meta.pathRewrites;
            stats.toolTokens += r.meta.toolTokens;
            stats.overridesApplied += r.meta.overridesApplied;
            stats.droppedKeys += r.meta.droppedKeys.length;
            stats.allowedToolsRestated += r.meta.allowedToolsRestated ? 1 : 0;
            stats.pathsAdded += r.meta.pathsAdded;
            stats.agentRefsRenamed += r.meta.agentRefsRenamed;
            stats.agentRefsStructured += r.meta.agentRefsStructured || 0;
            stats.mcpNeutralized += r.meta.mcpNeutralized;
            stats.argumentsRewritten += r.meta.argumentsRewritten;
            if (r.meta.changed) changedSkills.add(name);
            if (r.meta.pathsAdded > 0) pathSkills.add(name);
            return r.content;
          }
        : null;
      ops.push(createOp(path.join(skillDir, rel), path.join('skills', name, rel), transform));
    }
  }
  return { ops, skipped, included, stats, changedSkills, pathSkills };
}

function collectContexts() {
  const ops = [];
  const contextsRoot = path.join(REPO_ROOT, 'contexts');
  const ids = [];
  for (const f of fs.readdirSync(contextsRoot).filter(f => f.endsWith('.md')).sort()) {
    const id = f.slice(0, -3);
    const name = `ecc-context-${id}`;
    const content = R.buildContextSkill(id, fs.readFileSync(path.join(contextsRoot, f), 'utf8'));
    ids.push(id);
    ops.push(createOp(path.join(contextsRoot, f), path.join('skills', name, 'SKILL.md'), () => content));
  }
  return { ops, ids };
}

function markdownSeedText(srcAbs) {
  const upstreamCommandsDir = `${path.join(REPO_ROOT, 'commands')}${path.sep}`;
  if (!srcAbs.startsWith(upstreamCommandsDir)) return fs.readFileSync(srcAbs, 'utf8');
  const replacement = C.loadReplacement(REPO_ROOT, path.basename(srcAbs, '.md'));
  return replacement || fs.readFileSync(srcAbs, 'utf8');
}

function prepareCommands({ pathMap, builtSkills, ruleRefs, agentRefs }) {
  const commandStats = {
    pathRewrites: 0,
    toolTokens: 0,
    overridesApplied: 0,
    droppedKeys: 0,
    argumentHintsFolded: 0,
    argumentsRewritten: 0,
    agentRefsRenamed: 0,
    agentRefsStructured: 0,
    mcpNeutralized: 0,
    slashRewrites: 0,
    allowedToolsRestated: 0,
  };
  const renames = {};
  const commandNames = fs.readdirSync(path.join(REPO_ROOT, 'commands'))
    .filter(f => f.endsWith('.md'))
    .map(f => f.slice(0, -3));
  for (const stem of commandNames) {
    if (builtSkills.has(stem)) renames[stem] = C.pluginCommandName(stem, builtSkills);
  }
  const commandTransform = C.createCommandTransform({
    repoRoot: REPO_ROOT,
    pathMap,
    builtSkills,
    ruleRefs,
    agentRefs,
    renames,
  });
  const commands = collectCommands(commandTransform, builtSkills, commandStats);
  return { commands, commandStats };
}

function collectCommands(commandTransform, skillNames, stats) {
  const ops = [];
  const seen = new Set();
  const collisions = [];
  const changed = new Set();
  const bodiesReplaced = new Set();
  const add = (srcAbs, stem, sourceKind) => {
    const pluginName = C.pluginCommandName(stem, skillNames);
    const destRel = `commands/${pluginName}.md`;
    if (seen.has(destRel)) throw new Error(`command name collision: ${destRel}`);
    seen.add(destRel);
    if (pluginName !== stem) collisions.push({ from: stem, to: pluginName });
    ops.push(createOp(srcAbs, destRel, content => {
      const result = commandTransform(content, { commandName: stem, pluginName, sourceKind });
      const meta = result.meta;
      stats.pathRewrites += meta.pathRewrites;
      stats.toolTokens += meta.toolTokens;
      stats.overridesApplied += meta.overridesApplied;
      stats.droppedKeys += meta.droppedKeys.length;
      stats.argumentHintsFolded += meta.argumentHintsFolded;
      stats.argumentsRewritten += meta.argumentsRewritten;
      stats.agentRefsRenamed += meta.agentRefsRenamed;
      stats.agentRefsStructured += meta.agentRefsStructured;
      stats.mcpNeutralized += meta.mcpNeutralized;
      stats.slashRewrites += meta.slashRewrites;
      stats.allowedToolsRestated += meta.allowedToolsRestated ? 1 : 0;
      if (meta.changed) changed.add(pluginName);
      if (meta.bodyReplaced) bodiesReplaced.add(stem);
      return result.content;
    }));
  };
  const commandsRoot = path.join(REPO_ROOT, 'commands');
  for (const f of fs.readdirSync(commandsRoot).filter(f => f.endsWith('.md')).sort()) {
    add(path.join(commandsRoot, f), f.slice(0, -3), 'upstream');
  }
  const upstreamCount = ops.length;
  const overrideRoot = path.join(LAYER_ROOT, 'overrides', 'commands');
  const overrideNames = [];
  if (fs.existsSync(overrideRoot)) {
    for (const f of fs.readdirSync(overrideRoot).filter(f => f.endsWith('.md')).sort()) {
      add(path.join(overrideRoot, f), f.slice(0, -3), 'shim');
      overrideNames.push(f);
    }
  }
  return {
    ops,
    upstreamCount,
    overrideNames,
    collisions: collisions.sort((a, b) => a.from.localeCompare(b.from)),
    changed,
    bodiesReplaced,
  };
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

  // phase 3: agent-names.json (deterministic regeneration; `changed` flags
  // upstream drift to be reviewed and committed, PLAN.md section 10)
  const nameMapResult = N.writeAgentNameMap(REPO_ROOT);
  const nameMap = nameMapResult.agents;
  const agentRefs = createAgentRefTransform(nameMap);

  const ruleRefs = R.createRuleRefTransform(R.listRuleNamespaces(REPO_ROOT));
  const pathMap = S.loadPathMap(REPO_ROOT);
  const rules = collectRules(warnings, agentRefs);
  const agents = collectAgents(warnings, ruleRefs, agentRefs, nameMap, pathMap.agentOverrides);

  // phase 4: skill transform (path-map, frontmatter allowlist, ecc-* refs)
  const namespaces = R.listRuleNamespaces(REPO_ROOT);
  const namespaceGlobs = S.collectNamespaceGlobs(REPO_ROOT);
  const contextIds = fs.readdirSync(path.join(REPO_ROOT, 'contexts'))
    .filter(f => f.endsWith('.md')).map(f => `ecc-context-${f.slice(0, -3)}`);
  const builtSkills = new Set([
    ...[...composition.skillSet].filter(s => !exclusions.skills[s]),
    ...contextIds,
  ]);
  for (const alias of [...Object.keys(S.SKILL_PATH_EXACT), ...Object.keys(S.SKILL_PATH_PREFIX)]) {
    const hit = [...builtSkills].some(s => s === alias || s.startsWith(alias));
    if (!hit) warnings.push(`skills: path alias '${alias}' matches no included skill (upstream drift?)`);
  }
  const skillTransform = S.createSkillTransform({
    pathMap,
    builtSkills,
    namespaceGlobs,
    namespaces,
    ruleRefs,
    agentRefs,
  });
  const skills = collectSkills(composition.skillSet, exclusions, skillTransform);
  const contexts = collectContexts();
  const { commands, commandStats } = prepareCommands({ pathMap, builtSkills, ruleRefs, agentRefs });
  const hooks = collectHooks(hookMap);
  skipped.push(...rules.skipped, ...skills.skipped);

  // script refs from included markdown (roots 2-4) + hook entry points (root 1)
  const seedFiles = new Set();
  for (const op of [...skills.ops, ...commands.ops]) {
    if (!op.srcAbs.endsWith('.md')) continue;
    for (const ref of extractScriptRefs(markdownSeedText(op.srcAbs))) {
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

  const allOps = [...rules.ops, ...agents.ops, ...skills.ops, ...contexts.ops, ...commands.ops, ...hooks.ops, ...scripts.ops, ...staticOps]
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
    phase: 5,
    profile: 'full',
    modules: {
      included: composition.fullModules,
      notInProfile: composition.notInProfile,
      targetOverrides: Object.fromEntries(Object.entries(composition.overrides).map(([k, v]) => [k, { addTargets: v.addTargets || [] }])),
    },
    counts: {
      rules: rules.ops.length,
      agents: agents.ops.length,
      skills: skills.included.length + contexts.ops.length,
      commands: { upstream: commands.upstreamCount, overrides: commands.overrideNames.length, total: commands.ops.length },
      hooks: { events: hookEvents, entries: hookEntries },
      scripts: scripts.files.length,
      files: totalFiles,
      bytes,
    },
    rules: {
      total: rules.stats.total,
      withNativeFrontmatter: rules.stats.native,
      fromUpstream: rules.stats.upstream,
      alwaysApplyTrue: rules.stats.alwaysApplyTrue,
      withGlobs: rules.stats.withGlobs,
      withoutSourceFrontmatter: rules.stats.withoutSourceFrontmatter,
      renamedAgentRefs: rules.stats.renamedAgentRefs,
      renamedAgentRefsStructured: rules.stats.renamedAgentRefsStructured,
    },
    contextSkills: contexts.ids.map(id => `ecc-context-${id}`).sort(),
    skills: {
      total: skills.included.length,
      transformed: skills.changedSkills.size,
      pathRewrites: skills.stats.pathRewrites,
      toolTokens: skills.stats.toolTokens,
      overridesApplied: skills.stats.overridesApplied,
      droppedKeys: skills.stats.droppedKeys,
      allowedToolsRestated: skills.stats.allowedToolsRestated,
      pathsAdded: skills.stats.pathsAdded,
      langSkillsWithPaths: skills.pathSkills.size,
      langSkillNames: [...skills.pathSkills].sort(),
      agentRefsRenamed: skills.stats.agentRefsRenamed,
      agentRefsStructured: skills.stats.agentRefsStructured,
      mcpNeutralized: skills.stats.mcpNeutralized,
      argumentsRewritten: skills.stats.argumentsRewritten,
      pathMapRules: pathMap.rules.length,
      allowlisted: Object.keys(pathMap.claudeAllowlist || {}).sort(),
    },
    agents: {
      total: agents.stats.total,
      readonly: agents.stats.readonly,
      readonlyAgents: agents.stats.readonlyAgents,
      mcpServers: agents.stats.mcpServers,
      modelTiers: agents.stats.modelTiers,
      renamedRefs: agents.stats.renamedRefs,
      renamedRefsStructured: agents.stats.structuredRefs,
      nameMapChanged: nameMapResult.changed,
    },
    commands: {
      upstream: commands.upstreamCount,
      overrides: commands.overrideNames.length,
      total: commands.ops.length,
      transformed: commands.changed.size,
      pathRewrites: commandStats.pathRewrites,
      toolTokens: commandStats.toolTokens,
      overridesApplied: commandStats.overridesApplied,
      droppedKeys: commandStats.droppedKeys,
      argumentHintsFolded: commandStats.argumentHintsFolded,
      argumentsRewritten: commandStats.argumentsRewritten,
      agentRefsRenamed: commandStats.agentRefsRenamed,
      agentRefsStructured: commandStats.agentRefsStructured,
      mcpNeutralized: commandStats.mcpNeutralized,
      slashRewrites: commandStats.slashRewrites,
      allowedToolsRestated: commandStats.allowedToolsRestated,
      collisions: commands.collisions,
      bodiesReplaced: [...commands.bodiesReplaced].sort(),
      legacyShims: commands.overrideNames.map(name => name.replace(/\.md$/, '')).sort(),
    },
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
  console.log('ecc-cursor build OK (phase 5: commands)');
  const agentRefTotal = report.rules.renamedAgentRefs + report.agents.renamedRefs + report.skills.agentRefsRenamed + report.commands.agentRefsRenamed;
  const agentRefStructured = report.rules.renamedAgentRefsStructured + report.agents.renamedRefsStructured + report.skills.agentRefsStructured + report.commands.agentRefsStructured;
  console.log(`  rules:    ${c.rules} (native frontmatter: ${report.rules.withNativeFrontmatter}/${report.rules.total}, alwaysApply true: ${report.rules.alwaysApplyTrue}, agent refs renamed: ${report.rules.renamedAgentRefs}, structured: ${report.rules.renamedAgentRefsStructured})`);
  console.log(`  agents:   ${c.agents} (readonly: ${report.agents.readonly}, agent refs renamed: ${report.agents.renamedRefs}, structured: ${report.agents.renamedRefsStructured}, name map ${report.agents.nameMapChanged ? 'UPDATED' : 'unchanged'})`);
  console.log(`  skills:   ${c.skills} (${report.contextSkills.length} context skills; transformed ${report.skills.transformed}, path rewrites ${report.skills.pathRewrites}, agent refs renamed ${report.skills.agentRefsRenamed}, structured ${report.skills.agentRefsStructured}, lang skills with paths ${report.skills.langSkillsWithPaths})`);
  console.log(`  commands: ${c.commands.total} (upstream ${c.commands.upstream} + overrides ${c.commands.overrides}; transformed ${report.commands.transformed}, path rewrites ${report.commands.pathRewrites}, agent refs ${report.commands.agentRefsRenamed}, structured ${report.commands.agentRefsStructured}, collisions ${report.commands.collisions.length}, arguments ${report.commands.argumentsRewritten})`);
  console.log(`  agent refs renamed: ${agentRefTotal} (structured contexts: ${agentRefStructured})`);
  console.log(`  hooks:    ${c.hooks.events} events, ${c.hooks.entries} entries`);
  console.log(`  scripts:  ${c.scripts} (require-closure, ${report.scriptClosure.seeds.length} seeds)`);
  console.log(`  files:    ${c.files}, ${(c.bytes / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`  warnings: ${report.warnings.length}`);
  console.log(`  -> ${path.relative(REPO_ROOT, OUT_ROOT)}`);
  console.log(`  report -> ${path.relative(REPO_ROOT, REPORT_PATH)}`);
}

module.exports = { build, extractScriptRefs, OUT_ROOT, REPORT_PATH, REPO_ROOT };
