/**
 * Phase-3 tests for the ecc-cursor build: agent emitter + agent references.
 *
 * Covers: Cursor subagent frontmatter validity (name/description/model/
 * readonly allowlist per cursor.com/docs/subagents), hard rule 4 (no Claude
 * model tiers, no claude-* model ids), readonly on exactly the 11 strict
 * agents (PLAN.md section 8), agent-names.json integrity and drift sync,
 * agent-reference renames in agents and rules (with false-positive safety),
 * check-links agent resolution, and build determinism.
 *
 * Run with: node tests/cursor-plugin/agents.test.js
 * (picked up by tests/run-all.js; ECC_TEST_ONLY=cursor-plugin selects it)
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_ROOT = path.join(REPO_ROOT, 'build', 'cursor-plugin', 'ecc-cursor');
const REPORT_PATH = path.join(REPO_ROOT, 'build', 'cursor-plugin', 'report.json');
const T = require('../../scripts/lib/cursor-plugin/transforms');
const N = require('../../scripts/lib/cursor-plugin/agent-names');
const { createAgentRefTransform } = require('../../scripts/lib/cursor-plugin/agent-refs');
const { mapTool, isReadonlyToolset } = require('../../scripts/lib/cursor-plugin/tool-map');
const E = require('../../scripts/lib/cursor-plugin/agent-emit-cursor');
const { parseAllAgents } = require('../../scripts/lib/agent-ir');

// PLAN.md section 8: the strict read-only tool sets (Read/Grep/Glob only).
const READONLY_IDS = [
  'architect',
  'bengali-reviewer',
  'code-explorer',
  'comment-analyzer',
  'conversation-analyzer',
  'healthcare-reviewer',
  'homelab-architect',
  'network-architect',
  'network-config-reviewer',
  'planner',
  'type-design-analyzer',
];

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: options.cwd || REPO_ROOT,
    env: { ...process.env, ...(options.env || {}) },
    input: options.input,
    timeout: options.timeout || 120000,
  });
}

function hashTree(root) {
  const hash = crypto.createHash('sha256');
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        hash.update(path.relative(root, full).replace(/\\/g, '/'));
        hash.update('\0');
        hash.update(fs.readFileSync(full));
        hash.update('\0');
      }
    }
  };
  walk(root);
  return hash.digest('hex');
}

function listBuiltAgents() {
  const dir = path.join(OUT_ROOT, 'agents');
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
}

function listMarkdown(root) {
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && /\.(md|mdc)$/.test(e.name)) out.push(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL: ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

function runTests() {
  console.log('\n=== Testing cursor-plugin agents (phase 3) ===\n');
  let passed = 0;
  let failed = 0;
  const t = (name, fn) => (test(name, fn) ? passed++ : failed++);

  // 0. fresh build
  let report = null;
  t('build.js exits 0', () => {
    const r = runNode([path.join('scripts', 'cursor-plugin', 'build.js')]);
    assert.strictEqual(r.status, 0, `build failed:\n${r.stderr}\n${r.stdout}`);
    report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
  });
  if (!report) {
    console.log(`\n=== ${passed} passed, ${++failed} failed ===\n`);
    process.exit(1);
  }

  // 1. all built agents have valid Cursor frontmatter
  t('72 agents, name == ecc-<filename>, description, model inherit, allowlist keys only', () => {
    const files = listBuiltAgents();
    assert.strictEqual(files.length, 72, `expected 72 agents, got ${files.length}`);
    for (const f of files) {
      const content = fs.readFileSync(path.join(OUT_ROOT, 'agents', f), 'utf8');
      const fm = T.splitFrontmatter(content).frontmatter;
      assert.ok(fm, `${f}: no frontmatter`);
      const name = T.getFrontmatterField(fm, 'name');
      assert.strictEqual(name, f.slice(0, -3), `${f}: name != filename`);
      assert.ok(name.startsWith('ecc-'), `${f}: name without ecc- prefix`);
      assert.ok(T.getFrontmatterField(fm, 'description'), `${f}: no description`);
      assert.strictEqual(T.getFrontmatterField(fm, 'model'), 'inherit', `${f}: model not inherit`);
      assert.ok(!/^tools:/m.test(fm), `${f}: tools: key leaked into frontmatter`);
      assert.ok(!/^color:/m.test(fm), `${f}: color: key leaked into frontmatter`);
      // allowlist: name, description, model, readonly, is_background
      const keys = fm.split(/\r?\n/).filter(l => /^[a-z-]+:/.test(l)).map(l => l.split(':')[0]);
      for (const k of keys) {
        assert.ok(['name', 'description', 'model', 'readonly', 'is_background'].includes(k), `${f}: unexpected frontmatter key '${k}'`);
      }
    }
  });

  // 2. hard rule 4: no Claude model tiers, no claude-* model ids anywhere
  t('no model: sonnet|opus|haiku|fable, no claude-* model ids in built agents', () => {
    for (const f of listBuiltAgents()) {
      const content = fs.readFileSync(path.join(OUT_ROOT, 'agents', f), 'utf8');
      assert.ok(!/^model:[ \t]*(sonnet|opus|haiku|fable)\b/im.test(content), `${f}: forbidden model tier`);
      assert.ok(!/\bclaude-(sonnet|opus|haiku|fable)[\w.-]*\b/i.test(content), `${f}: claude-* model id`);
    }
  });

  // 3. readonly exactly on the 11 strict agents (PLAN.md section 8)
  t('readonly: true on exactly the 11 strict agents', () => {
    const readonly = listBuiltAgents().filter(f => {
      const fm = T.splitFrontmatter(fs.readFileSync(path.join(OUT_ROOT, 'agents', f), 'utf8')).frontmatter;
      return T.getFrontmatterField(fm, 'readonly') === 'true';
    });
    const expected = READONLY_IDS.map(id => `ecc-${id}.md`).sort();
    assert.deepStrictEqual(readonly, expected, `readonly set differs: ${readonly.join(', ')}`);
    assert.strictEqual(report.agents.readonly, 11);
    assert.deepStrictEqual(report.agents.readonlyAgents, READONLY_IDS.slice().sort());
  });

  // 4. source tools restated in body; mcp__* pulled out as MCP requirement
  t('Recommended tools paragraph in every agent; MCP requirement for docs-lookup/gan-evaluator', () => {
    for (const f of listBuiltAgents()) {
      const content = fs.readFileSync(path.join(OUT_ROOT, 'agents', f), 'utf8');
      assert.ok(content.includes('## Recommended tools'), `${f}: no Recommended tools section`);
      assert.ok(!/^tools:/m.test(content), `${f}: tools list in frontmatter position`);
    }
    const docsLookup = fs.readFileSync(path.join(OUT_ROOT, 'agents', 'ecc-docs-lookup.md'), 'utf8');
    assert.ok(docsLookup.includes('MCP tools required:'), 'docs-lookup: no MCP requirement');
    assert.ok(docsLookup.includes('`context7` MCP server'), 'docs-lookup: context7 not named');
    assert.ok(!/mcp__context7/.test(docsLookup), 'docs-lookup: raw mcp__ tool leaked');
    const ganEval = fs.readFileSync(path.join(OUT_ROOT, 'agents', 'ecc-gan-evaluator.md'), 'utf8');
    assert.ok(ganEval.includes('`playwright` MCP server'), 'gan-evaluator: playwright not named');
    assert.ok(!/mcp__playwright/.test(ganEval), 'gan-evaluator: raw mcp__ tool leaked');
    // Bash is rendered under its Cursor name
    const codeReviewer = fs.readFileSync(path.join(OUT_ROOT, 'agents', 'ecc-code-reviewer.md'), 'utf8');
    assert.ok(codeReviewer.includes('Shell (source `Bash`)'), 'code-reviewer: Bash not mapped to Shell');
  });

  // 5. agent-names.json: one entry per upstream agent, unique, in sync (drift)
  t('agent-names.json: 72 entries, unique ecc-* values, committed file in sync', () => {
    const file = JSON.parse(fs.readFileSync(N.agentNameMapPath(REPO_ROOT), 'utf8'));
    const entries = Object.entries(file.agents);
    const sourceIds = fs.readdirSync(path.join(REPO_ROOT, 'agents')).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3));
    assert.strictEqual(entries.length, sourceIds.length, 'map size != agents/ size');
    assert.strictEqual(entries.length, 72);
    for (const id of sourceIds) {
      assert.ok(file.agents[id], `map missing ${id}`);
      assert.strictEqual(file.agents[id], `ecc-${id}`);
    }
    const values = new Set(entries.map(([, v]) => v));
    assert.strictEqual(values.size, entries.length, 'map values not unique');
    for (const v of values) assert.ok(/^ecc-[a-z0-9-]+$/.test(v), `bad mapped name: ${v}`);
    // drift: committed file must equal a fresh deterministic regeneration
    const regenerated = N.serializeAgentNameMap(N.buildAgentNameMap(REPO_ROOT));
    assert.strictEqual(fs.readFileSync(N.agentNameMapPath(REPO_ROOT), 'utf8'), regenerated, 'agent-names.json stale (upstream drift - commit the regenerated map)');
  });

  // 6. renamed references in agents: no bare names in reference contexts
  t('agent bodies: backticked/bold/X-agent references all carry ecc- prefix', () => {
    const map = N.loadAgentNameMap(REPO_ROOT);
    const bareAlt = Object.keys(map).sort((a, b) => b.length - a.length).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const contexts = [
      new RegExp('`' + `(?:${bareAlt})` + '`'),
      new RegExp('\\*\\*' + `(?:${bareAlt})` + '\\*\\*'),
      new RegExp(`(?<![\\w-])(?:${bareAlt})(?= (?:agent|subagent)\\b)`),
      new RegExp(`(?<![\\w-])ecc:(?:${bareAlt})(?![\\w-])`),
    ];
    for (const f of listBuiltAgents()) {
      const content = fs.readFileSync(path.join(OUT_ROOT, 'agents', f), 'utf8');
      for (const re of contexts) {
        const m = content.match(re);
        assert.ok(!m, `${f}: unrenamed agent reference '${m && m[0]}'`);
      }
    }
    assert.ok(report.agents.renamedRefs > 0, 'expected renames in agent bodies');
  });

  // 7. renamed references in rules (native copies included)
  t('rule bodies: agent references carry ecc- prefix (incl. native common-agents)', () => {
    const map = N.loadAgentNameMap(REPO_ROOT);
    const bareAlt = Object.keys(map).sort((a, b) => b.length - a.length).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const contexts = [
      new RegExp('`' + `(?:${bareAlt})` + '`'),
      new RegExp('\\*\\*' + `(?:${bareAlt})` + '\\*\\*'),
      new RegExp(`(?<![\\w-])(?:${bareAlt})(?= (?:agent|subagent)\\b)`),
      new RegExp(`\\|\\s*(?:${bareAlt})\\s*\\|`),
      new RegExp(`(?<![\\w-])ecc:(?:${bareAlt})(?![\\w-])`),
    ];
    const rulesDir = path.join(OUT_ROOT, 'rules');
    for (const f of fs.readdirSync(rulesDir).filter(f => f.endsWith('.mdc'))) {
      const content = fs.readFileSync(path.join(rulesDir, f), 'utf8');
      for (const re of contexts) {
        const m = content.match(re);
        assert.ok(!m, `${f}: unrenamed agent reference '${m && m[0]}'`);
      }
    }
    const commonAgents = fs.readFileSync(path.join(rulesDir, 'common-agents.mdc'), 'utf8');
    assert.ok(commonAgents.includes('| ecc-planner |'), 'common-agents: table cell not renamed');
    assert.ok(commonAgents.includes('**ecc-code-reviewer** agent'), 'common-agents: bold ref not renamed');
    assert.ok(report.rules.renamedAgentRefs > 0, 'expected renames in rule bodies');
  });

  // 8. no references to nonexistent ecc-* agents in agents and rules
  t('every ecc-* agent token in agents/rules resolves to a built agent', () => {
    const built = new Set(listBuiltAgents().map(f => f.slice(0, -3)));
    const map = N.loadAgentNameMap(REPO_ROOT);
    const knownNonAgents = new Set(['ecc-cursor', 'ecc-guide']); // plugin name, command/skill names
    const roots = [path.join(OUT_ROOT, 'agents'), path.join(OUT_ROOT, 'rules')];
    for (const root of roots) {
      for (const file of listMarkdown(root)) {
        const content = fs.readFileSync(file, 'utf8');
        const tokens = content.match(/\becc-[a-z0-9-]+\b/g) || [];
        for (const tok of tokens) {
          if (built.has(tok) || knownNonAgents.has(tok)) continue;
          const bare = tok.slice(4);
          assert.ok(!map[bare], `${path.relative(OUT_ROOT, file)}: '${tok}' looks like a renamed agent but is not built`);
        }
      }
    }
  });

  // 9. false positives: ordinary words and self-signatures stay untouched
  t('false positives untouched: software architect, architecture planner, signatures', () => {
    const architect = fs.readFileSync(path.join(OUT_ROOT, 'agents', 'ecc-architect.md'), 'utf8');
    assert.ok(architect.includes('senior software architect specializing'), 'architect prose must stay bare');
    const network = fs.readFileSync(path.join(OUT_ROOT, 'agents', 'ecc-network-architect.md'), 'utf8');
    assert.ok(network.includes('senior network architecture planner.'), 'planner prose must stay bare');
    const homelab = fs.readFileSync(path.join(OUT_ROOT, 'agents', 'ecc-homelab-architect.md'), 'utf8');
    assert.ok(homelab.includes('practical homelab network architect'), 'homelab prose must stay bare');
    const specMiner = fs.readFileSync(path.join(OUT_ROOT, 'agents', 'ecc-spec-miner.md'), 'utf8');
    assert.ok(specMiner.includes('Auto-extracted by spec-miner.'), 'output template signature must stay bare');
  });

  // 10. unit: tool-map
  t('tool-map: native/mcp/unknown kinds, readonly classification', () => {
    assert.deepStrictEqual(mapTool('Read'), { kind: 'native', cursor: 'Read', readonly: true });
    assert.deepStrictEqual(mapTool('Bash'), { kind: 'native', cursor: 'Shell', readonly: false });
    assert.strictEqual(mapTool('mcp__context7__query-docs').kind, 'mcp');
    assert.strictEqual(mapTool('mcp__context7__query-docs').server, 'context7');
    assert.strictEqual(mapTool('mcp__context7__query-docs').tool, 'query-docs');
    assert.strictEqual(mapTool('Frobnicate').kind, 'unknown');
    assert.strictEqual(isReadonlyToolset(['Read', 'Grep', 'Glob']), true);
    assert.strictEqual(isReadonlyToolset(['Read', 'Grep']), true);
    assert.strictEqual(isReadonlyToolset(['Read', 'Bash']), false);
    assert.strictEqual(isReadonlyToolset(['Read', 'mcp__context7__query-docs']), false);
    assert.strictEqual(isReadonlyToolset([]), false);
  });

  // 11. unit: emitter shape on the real IR set
  t('emitter: model inherit, readonly set, MCP servers, sorted output', () => {
    const irs = parseAllAgents(path.join(REPO_ROOT, 'agents'));
    const map = N.buildAgentNameMap(REPO_ROOT);
    const { results, warnings, stats } = E.emitAllCursorAgents(irs, { nameMap: map });
    assert.strictEqual(warnings.length, 0, `unexpected emitter warnings: ${warnings.join('; ')}`);
    assert.strictEqual(results.length, 72);
    const ids = results.map(r => r.id);
    assert.deepStrictEqual(ids, ids.slice().sort(), 'results not sorted by id');
    assert.deepStrictEqual(stats.modelTiers, { sonnet: 62, opus: 4, haiku: 6 });
    assert.deepStrictEqual(stats.mcpServers, { context7: 1, playwright: 1 });
    assert.strictEqual(stats.readonly, 11);
    for (const r of results) {
      assert.ok(r.markdown.startsWith('---\n'), `${r.id}: bad frontmatter start`);
      assert.ok(r.markdown.includes('\nmodel: inherit\n'), `${r.id}: model inherit missing`);
      assert.ok(!r.markdown.includes(`name: ${r.id}\n`), `${r.id}: bare name in frontmatter`);
    }
  });

  // 12. unit: reference transform patterns and idempotency
  t('agent-refs: all patterns rename, false positives safe, idempotent', () => {
    const map = { planner: 'ecc-planner', architect: 'ecc-architect', 'homelab-architect': 'ecc-homelab-architect', 'gan-planner': 'ecc-gan-planner', 'opensource-sanitizer': 'ecc-opensource-sanitizer', 'typescript-reviewer': 'ecc-typescript-reviewer' };
    const tr = createAgentRefTransform(map);
    const cases = [
      ['ecc:planner', 'ecc-planner'], // P1
      ['subagent_type: "planner"', 'subagent_type: "ecc-planner"'], // P6
      ['use `planner` now', 'use `ecc-planner` now'], // P2
      ['Use **planner** agent', 'Use **ecc-planner** agent'], // P3
      ['call @planner next', 'call @ecc-planner next'], // P4
      ['| planner | x |', '| ecc-planner | x |'], // P5
      ['use planner agent when', 'use ecc-planner agent when'], // P7
      ['## Scope vs typescript-reviewer', '## Scope vs ecc-typescript-reviewer'], // P8
      ['Run opensource-sanitizer to verify', 'Run ecc-opensource-sanitizer to verify'], // P9
      // suffix-name safety: longest alternative wins
      ['`gan-planner`', '`ecc-gan-planner`'],
      ['**homelab-architect**', '**ecc-homelab-architect**'],
      ['| architect |', '| ecc-architect |'],
    ];
    for (const [input, expected] of cases) {
      const r = tr(input);
      assert.strictEqual(r.content, expected, `input: ${input}`);
      assert.strictEqual(r.replacements, 1, `expected 1 replacement for: ${input}`);
    }
    const untouched = [
      'senior software architect specializing in design',
      'network architecture planner. Produce',
      'email user@planner.com for details',
      'Auto-extracted by spec-miner.',
      'npm i -D @types/react',
      'the planner notebook layout',
      'ecc-planner already renamed',
      'Use **ecc-planner** agent',
      '| ecc-architect | x |',
      'Run ecc-opensource-sanitizer again',
    ];
    for (const input of untouched) {
      const r = tr(input);
      assert.strictEqual(r.content, input, `false positive rewrite: ${input} -> ${r.content}`);
      assert.strictEqual(r.replacements, 0, `expected 0 replacements for: ${input}`);
    }
    // idempotent on realistic content
    const once = tr('Use **planner** agent, then `architect`; subagent_type: "gan-planner". Run opensource-sanitizer.');
    const twice = tr(once.content);
    assert.strictEqual(twice.content, once.content, 'transform not idempotent');
    assert.strictEqual(twice.replacements, 0);
  });

  // 13. check-links: zero broken agent references against the build
  t('check-links: 0 broken agent targets; overall baseline (14) not exceeded', () => {
    const { checkLinks } = require('../../scripts/cursor-plugin/check-links');
    const { broken, total } = checkLinks();
    assert.strictEqual(broken.agents.size, 0, `broken agent refs: ${[...broken.agents.keys()].join(', ')}`);
    assert.ok(total <= 14, `baseline grew: ${total} > 14`);
  });

  // 14. validate.js green
  t('validate.js exits 0', () => {
    const r = runNode([path.join('scripts', 'cursor-plugin', 'validate.js')]);
    assert.strictEqual(r.status, 0, `validate failed:\n${r.stderr}\n${r.stdout}`);
  });

  // 15. determinism: agents/ tree byte-identical across builds
  t('two builds produce byte-identical agents/', () => {
    const before = hashTree(path.join(OUT_ROOT, 'agents'));
    const r = runNode([path.join('scripts', 'cursor-plugin', 'build.js')]);
    assert.strictEqual(r.status, 0, `second build failed:\n${r.stderr}`);
    assert.strictEqual(hashTree(path.join(OUT_ROOT, 'agents')), before, 'agents/ differs between runs');
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
