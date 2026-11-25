/**
 * Phase-4 tests for the ecc-cursor build: skills transform.
 *
 * Covers: Cursor frontmatter allowlist (name == folder, description present,
 * no allowed-tools/tools/argument-hint), path-map rewrites (one fixture per
 * rule), per-skill overrides, .claude/ allowlist, $ARGUMENTS /
 * ${CLAUDE_PLUGIN_ROOT} elimination, paths: injection for language skills,
 * link integrity (skill->skill/agent/script), false-positive safety and
 * idempotency of the transform.
 *
 * Run with: node tests/cursor-plugin/skills.test.js
 * (picked up by tests/run-all.js; ECC_TEST_ONLY=cursor-plugin selects it)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_ROOT = path.join(REPO_ROOT, 'build', 'cursor-plugin', 'ecc-cursor');
const REPORT_PATH = path.join(REPO_ROOT, 'build', 'cursor-plugin', 'report.json');
const S = require('../../scripts/lib/cursor-plugin/skills');
const R = require('../../scripts/lib/cursor-plugin/rules');
const T = require('../../scripts/lib/cursor-plugin/transforms');
const N = require('../../scripts/lib/cursor-plugin/agent-names');
const { createAgentRefTransform } = require('../../scripts/lib/cursor-plugin/agent-refs');
const { checkLinks } = require('../../scripts/cursor-plugin/check-links');

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: options.cwd || REPO_ROOT,
    env: { ...process.env, ...(options.env || {}) },
    input: options.input,
    timeout: options.timeout || 120000,
  });
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

function walkMd(root) {
  const out = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
    }
  };
  walk(root);
  return out;
}

function topLevelKeys(frontmatter) {
  const keys = [];
  for (const line of frontmatter.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z][\w-]*):/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

/** Transform factory with the real maps but a synthetic built-skill set. */
function makeTransform(builtSkills) {
  const namespaces = R.listRuleNamespaces(REPO_ROOT);
  return S.createSkillTransform({
    pathMap: S.loadPathMap(REPO_ROOT),
    builtSkills: builtSkills || new Set(['my-skill']),
    namespaceGlobs: S.collectNamespaceGlobs(REPO_ROOT),
    namespaces,
    ruleRefs: R.createRuleRefTransform(namespaces),
    agentRefs: createAgentRefTransform(N.loadAgentNameMap(REPO_ROOT)),
  });
}

function runTests() {
  console.log('\n=== Testing cursor-plugin skills transform (phase 4) ===\n');
  let passed = 0;
  let failed = 0;
  const t = (name, fn) => (test(name, fn) ? passed++ : failed++);

  // 1. build runs, report numbers
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

  t('report.skills: 322 upstream skills, 68 lang skills with paths, 23 path rules, 17 allowlisted', () => {
    assert.strictEqual(report.skills.total, 322);
    assert.strictEqual(report.counts.skills, 325); // 322 + 3 context skills
    assert.strictEqual(report.skills.langSkillsWithPaths, 68);
    assert.strictEqual(report.skills.langSkillNames.length, 68);
    assert.strictEqual(report.skills.pathMapRules, 23);
    assert.strictEqual(report.skills.allowlisted.length, 17);
    assert.strictEqual(report.skills.allowedToolsRestated, 2); // inherit-legacy-style, videodb
    assert.ok(report.skills.pathRewrites > 0, 'no path rewrites recorded');
    assert.ok(report.skills.agentRefsRenamed > 0, 'no agent refs renamed');
  });

  // 2. built skill frontmatter
  const builtSkillsRoot = path.join(OUT_ROOT, 'skills');
  const builtSkillDirs = fs.readdirSync(builtSkillsRoot, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name);

  t('every built skill: SKILL.md with name == folder and description', () => {
    assert.strictEqual(builtSkillDirs.length, 325);
    for (const name of builtSkillDirs) {
      const file = path.join(builtSkillsRoot, name, 'SKILL.md');
      assert.ok(fs.existsSync(file), `SKILL.md missing for ${name}`);
      const fm = T.splitFrontmatter(fs.readFileSync(file, 'utf8')).frontmatter;
      assert.ok(fm, `no frontmatter: ${name}`);
      assert.strictEqual(T.getFrontmatterField(fm, 'name'), name, `name != folder: ${name}`);
      assert.ok(T.getFrontmatterField(fm, 'description'), `no description: ${name}`);
    }
  });

  t('frontmatter keys within the Cursor allowlist everywhere', () => {
    const allow = S.FRONTMATTER_ALLOWLIST;
    for (const name of builtSkillDirs) {
      const fm = T.splitFrontmatter(fs.readFileSync(path.join(builtSkillsRoot, name, 'SKILL.md'), 'utf8')).frontmatter;
      for (const key of topLevelKeys(fm)) {
        assert.ok(allow.has(key), `skill ${name}: unsupported frontmatter key '${key}'`);
      }
    }
  });

  // 3. forbidden tokens
  t('0 allowed-tools / tools / argument-hint keys, 0 $ARGUMENTS, 0 ${CLAUDE_PLUGIN_ROOT} in built skills', () => {
    for (const file of walkMd(builtSkillsRoot)) {
      const content = fs.readFileSync(file, 'utf8');
      const rel = path.relative(OUT_ROOT, file);
      assert.ok(!/^allowed-tools:/m.test(content), `allowed-tools in ${rel}`);
      assert.ok(!content.includes('$ARGUMENTS'), `$ARGUMENTS in ${rel}`);
      assert.ok(!content.includes('${CLAUDE_PLUGIN_ROOT}'), `\${CLAUDE_PLUGIN_ROOT} in ${rel}`);
      const fm = T.splitFrontmatter(content).frontmatter;
      if (fm) {
        assert.ok(!/^tools:/m.test(fm), `tools: key in ${rel}`);
        assert.ok(!/^argument-hint:/m.test(fm), `argument-hint: key in ${rel}`);
      }
    }
  });

  // 4. .claude/ only on allowlisted lines
  t('0 .claude/ outside the path-map allowlist', () => {
    const allowlist = S.loadPathMap(REPO_ROOT).claudeAllowlist;
    for (const name of builtSkillDirs) {
      for (const file of walkMd(path.join(builtSkillsRoot, name))) {
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, i) => {
          if (!line.includes('.claude/')) return;
          const entry = allowlist[name];
          const ok = entry && (entry.patterns.includes('*') || entry.patterns.some(p => line.includes(p)));
          assert.ok(ok, `.claude/ outside allowlist: ${name}/${path.basename(file)}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
      }
    }
  });

  t('allowlist drift guard: allowlisted content still present in the build', () => {
    const allowlist = S.loadPathMap(REPO_ROOT).claudeAllowlist;
    for (const [name, entry] of Object.entries(allowlist)) {
      const file = path.join(builtSkillsRoot, name, 'SKILL.md');
      assert.ok(fs.existsSync(file), `allowlisted skill not in build: ${name}`);
      const content = fs.readFileSync(file, 'utf8');
      if (entry.patterns.includes('*')) {
        assert.ok(content.includes('.claude/'), `allowlist stale for ${name}: no .claude/ left (drop the entry)`);
      } else {
        for (const p of entry.patterns) {
          assert.ok(content.includes(p), `allowlist stale for ${name}: '${p}' not found`);
        }
      }
    }
  });

  // 5. path-map rule fixtures (one per rule)
  t('every path-map rule transforms its own fixture', () => {
    const pathMap = S.loadPathMap(REPO_ROOT);
    const tr = makeTransform();
    for (const rule of pathMap.rules) {
      assert.ok(rule.example && typeof rule.example.in === 'string', `rule ${rule.id} has no example fixture`);
      const r = tr(`${rule.example.in}\n`, { skillName: 'fixture-skill', isSkillMd: false });
      assert.strictEqual(r.content, `${rule.example.out}\n`, `rule ${rule.id}: '${rule.example.in}' -> '${r.content.trim()}'`);
    }
  });

  t('path-map rules are idempotent (second pass changes nothing)', () => {
    const pathMap = S.loadPathMap(REPO_ROOT);
    const tr = makeTransform();
    for (const rule of pathMap.rules) {
      const once = tr(`${rule.example.out}\n`, { skillName: 'fixture-skill', isSkillMd: false });
      assert.strictEqual(once.content, `${rule.example.out}\n`, `rule ${rule.id} is not idempotent on its own output`);
    }
  });

  // 6. per-skill overrides
  t('every skill override fires on the source and lands in the build', () => {
    const pathMap = S.loadPathMap(REPO_ROOT);
    for (const [skill, overrides] of Object.entries(pathMap.skillOverrides)) {
      const srcDir = path.join(REPO_ROOT, 'skills', skill);
      const srcFiles = walkMd(srcDir);
      for (const ov of overrides) {
        const srcHit = srcFiles.find(file => fs.readFileSync(file, 'utf8').includes(ov.match));
        assert.ok(srcHit, `override ${ov.id}: match not found in source skills/${skill} (upstream drift)`);
        const rel = path.relative(srcDir, srcHit);
        const built = fs.readFileSync(path.join(builtSkillsRoot, skill, rel), 'utf8');
        assert.ok(!built.includes(ov.match), `override ${ov.id}: match survived in the build`);
        if (ov.replace) assert.ok(built.includes(ov.replace), `override ${ov.id}: replacement not in the build`);
      }
    }
  });

  // 7. excluded-skill references are gone
  t('no references to excluded skills (dmux-workflows, hermes-imports) in built markdown', () => {
    for (const file of walkMd(OUT_ROOT)) {
      const content = fs.readFileSync(file, 'utf8');
      const rel = path.relative(OUT_ROOT, file);
      assert.ok(!content.includes('dmux-workflows'), `dmux-workflows referenced in ${rel}`);
      assert.ok(!content.includes('hermes-imports'), `hermes-imports referenced in ${rel}`);
    }
  });

  // 8. paths: injection
  t('paths: injected for language skills from rule globs; denylist respected', () => {
    const read = name => fs.readFileSync(path.join(builtSkillsRoot, name, 'SKILL.md'), 'utf8');
    const ts = T.splitFrontmatter(read('typescript-patterns')).frontmatter;
    assert.ok(/^paths:/m.test(ts), 'typescript-patterns has no paths:');
    assert.ok(ts.includes('"**/*.ts"'), 'typescript-patterns paths lack **/*.ts');
    const rn = T.splitFrontmatter(read('react-native-patterns')).frontmatter;
    assert.ok(/^paths:/m.test(rn), 'react-native-patterns has no paths:');
    assert.ok(!rn.includes('"**/*.jsx"'), 'react-native-patterns must use react-native (not react) globs');
    const denied = T.splitFrontmatter(read('web-perimeter-owasp-2025-audit')).frontmatter;
    assert.ok(!/^paths:/m.test(denied), 'denylisted skill got paths:');
    for (const name of report.skills.langSkillNames) {
      const fm = T.splitFrontmatter(read(name)).frontmatter;
      assert.ok(/^paths:/m.test(fm), `${name} listed in report but has no paths:`);
    }
  });

  // 9. allowed-tools restated in the body
  t('allowed-tools restated as a Recommended tools paragraph (inherit-legacy-style, videodb)', () => {
    for (const name of ['inherit-legacy-style', 'videodb']) {
      const built = fs.readFileSync(path.join(builtSkillsRoot, name, 'SKILL.md'), 'utf8');
      assert.ok(!/^allowed-tools:/m.test(built), `${name} still has allowed-tools key`);
      assert.ok(built.includes('\n\n## Recommended tools\n'), `${name} missing Recommended tools paragraph`);
      assert.ok(!/\bBash\b/.test(built.split('## Recommended tools')[1]), `${name} restatement still says Bash`);
    }
  });

  // 10. link integrity from skills
  t('check-links: 0 broken skill/agent/rule/command targets referenced from skills/', () => {
    const { broken } = checkLinks();
    for (const type of ['skills', 'agents', 'rules', 'commands']) {
      for (const [target, sites] of broken[type].entries()) {
        const fromSkills = [...sites].filter(s => s.startsWith('skills/'));
        assert.strictEqual(fromSkills.length, 0, `broken ${type} target '${target}' referenced from ${fromSkills.join(', ')}`);
      }
    }
  });

  t('check-links: excluded skills no longer broken; baseline does not grow', () => {
    const { broken, total } = checkLinks();
    assert.ok(!broken.skills.has('dmux-workflows'), 'dmux-workflows still a broken target');
    assert.ok(!broken.skills.has('hermes-imports'), 'hermes-imports still a broken target');
    assert.strictEqual(total, 0, `broken targets remain: ${total}`);
  });

  t('every node script referenced from built skills resolves in the build (repo scripts/ or skill-local)', () => {
    const SCRIPT_RE = /(?:^|[\s"'`(=])((?:\.{1,2}\/)?scripts\/[\w@+.,~/-]+\.(?:js|cjs|mjs))\b/gm;
    const missing = new Set();
    for (const file of walkMd(builtSkillsRoot)) {
      const skillName = path.relative(builtSkillsRoot, file).split(path.sep)[0];
      const content = fs.readFileSync(file, 'utf8');
      let m;
      while ((m = SCRIPT_RE.exec(content)) !== null) {
        let ref = m[1];
        if (ref.startsWith('./')) ref = ref.slice(2);
        if (ref.startsWith('../')) continue;
        if (fs.existsSync(path.join(OUT_ROOT, ref))) continue;
        if (fs.existsSync(path.join(builtSkillsRoot, skillName, ref))) continue; // intra-skill scripts/
        missing.add(`${ref} <- ${T.toPosix(path.relative(OUT_ROOT, file))}`);
      }
    }
    assert.deepStrictEqual([...missing].sort(), []);
  });

  // 11. transform safety: false positives and idempotency on real files
  t('transform is idempotent on real skill files', () => {
    const tr = makeTransform(new Set(builtSkillDirs));
    for (const name of ['typescript-patterns', 'cost-tracking', 'skill-host-compat', 'tdd-workflow', 'inherit-legacy-style', 'continuous-learning-v2', 'plan-canvas']) {
      const src = fs.readFileSync(path.join(REPO_ROOT, 'skills', name, 'SKILL.md'), 'utf8');
      const once = tr(src, { skillName: name, isSkillMd: true });
      const twice = tr(once.content, { skillName: name, isSkillMd: true });
      assert.strictEqual(twice.content, once.content, `transform not idempotent for ${name}`);
    }
  });

  t('false positives: plain prose agent words and emails are untouched', () => {
    const tr = makeTransform();
    const prose = [
      'A senior software architect reviewed the design.',
      'Contact planner@example.com for details.',
      'The network architecture planner role is documented elsewhere.',
      'Auto-extracted by spec-miner.',
    ].join('\n');
    const r = tr(`${prose}\n`, { skillName: 'fixture-skill', isSkillMd: false });
    assert.strictEqual(r.content, `${prose}\n`);
  });

  t('agent references in skills are renamed to ecc-* (spot check)', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'tdd-workflow', 'SKILL.md'), 'utf8');
    const built = fs.readFileSync(path.join(builtSkillsRoot, 'tdd-workflow', 'SKILL.md'), 'utf8');
    if (/\becc:tdd-guide\b|`tdd-guide`/.test(src)) {
      assert.ok(built.includes('ecc-tdd-guide'), 'tdd-guide reference not renamed');
    }
    // renamed references must point at built agents
    const agentsDir = fs.readdirSync(path.join(OUT_ROOT, 'agents')).map(f => f.slice(0, -3));
    for (const m of built.matchAll(/\becc-[a-z0-9-]+\b/g)) {
      if (m[0] === 'ecc-plugin-root') continue;
      assert.ok(agentsDir.includes(m[0]) || !/^ecc-(planner|architect|tdd-guide)$/.test(m[0]), `unknown ecc agent ${m[0]}`);
    }
  });

  // 12. context skills untouched by the skill transform
  t('context skills keep their generated form (disable-model-invocation, name == folder)', () => {
    for (const name of ['ecc-context-dev', 'ecc-context-research', 'ecc-context-review']) {
      const built = fs.readFileSync(path.join(builtSkillsRoot, name, 'SKILL.md'), 'utf8');
      const fm = T.splitFrontmatter(built).frontmatter;
      assert.strictEqual(T.getFrontmatterField(fm, 'name'), name);
      assert.strictEqual(T.getFrontmatterField(fm, 'disable-model-invocation'), 'true');
      assert.ok(!/^paths:/m.test(fm), `context skill ${name} got paths:`);
    }
  });

  // 13. validate
  t('validate.js exits 0', () => {
    const r = runNode([path.join('scripts', 'cursor-plugin', 'validate.js')]);
    assert.strictEqual(r.status, 0, `validate failed:\n${r.stderr}\n${r.stdout}`);
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
