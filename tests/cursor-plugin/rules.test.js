/**
 * Phase-2 tests for the ecc-cursor build: rules transform + context skills.
 *
 * Run with: node tests/cursor-plugin/rules.test.js
 * (picked up by tests/run-all.js; ECC_TEST_ONLY=cursor-plugin selects it)
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_ROOT = path.join(REPO_ROOT, 'build', 'cursor-plugin', 'ecc-cursor');
const T = require('../../scripts/lib/cursor-plugin/transforms');
const R = require('../../scripts/lib/cursor-plugin/rules');

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

function listBuiltRules() {
  const dir = path.join(OUT_ROOT, 'rules');
  return fs.readdirSync(dir).filter(f => f.endsWith('.mdc')).sort();
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
  console.log('\n=== Testing cursor-plugin rules + contexts (phase 2) ===\n');
  let passed = 0;
  let failed = 0;
  const t = (name, fn) => (test(name, fn) ? passed++ : failed++);

  // 0. fresh build
  t('build.js exits 0', () => {
    const r = runNode([path.join('scripts', 'cursor-plugin', 'build.js')]);
    assert.strictEqual(r.status, 0, `build failed:\n${r.stderr}\n${r.stdout}`);
  });

  // 1. every built rule has valid Cursor frontmatter
  t('121 rules, all with description + alwaysApply, globs iff not alwaysApply', () => {
    const files = listBuiltRules();
    assert.strictEqual(files.length, 121, `expected 121 rules, got ${files.length}`);
    for (const f of files) {
      const content = fs.readFileSync(path.join(OUT_ROOT, 'rules', f), 'utf8');
      const fm = T.splitFrontmatter(content).frontmatter;
      assert.ok(fm, `${f}: no frontmatter`);
      assert.ok(T.getFrontmatterField(fm, 'description'), `${f}: no description`);
      const alwaysApply = T.getFrontmatterField(fm, 'alwaysApply');
      assert.ok(alwaysApply === 'true' || alwaysApply === 'false', `${f}: bad alwaysApply '${alwaysApply}'`);
      const hasGlobs = /^globs:/m.test(fm);
      if (alwaysApply === 'false') assert.ok(hasGlobs, `${f}: alwaysApply false without globs`);
      if (alwaysApply === 'true') assert.ok(f.startsWith('common-'), `${f}: alwaysApply true outside common`);
    }
  });

  // 2. no Claude-style remnants
  t('no paths:, no .claude/ in built rules', () => {
    for (const f of listBuiltRules()) {
      const content = fs.readFileSync(path.join(OUT_ROOT, 'rules', f), 'utf8');
      assert.ok(!/^paths:/m.test(content), `${f}: still has paths:`);
      assert.ok(!content.includes('.claude/'), `${f}: references .claude/`);
    }
  });

  // 3. flat names are unique (collision would have thrown at build time)
  t('flattened rule names are unique across namespaces', () => {
    const seen = new Map();
    const rulesRoot = path.join(REPO_ROOT, 'rules');
    for (const ns of R.listRuleNamespaces(REPO_ROOT)) {
      const walk = dir => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.isFile()) {
            const rel = path.relative(path.join(rulesRoot, ns), full).replace(/\\/g, '/');
            const flat = T.flattenRuleName(ns, rel);
            if (!flat) continue;
            assert.ok(!seen.has(flat), `collision: ${flat} (${ns}/${rel} and ${seen.get(flat)})`);
            seen.set(flat, `${ns}/${rel}`);
          }
        }
      };
      walk(path.join(rulesRoot, ns));
    }
    assert.strictEqual(seen.size, 121);
  });

  // 4. native .cursor/rules copies are used verbatim (frontmatter match)
  t('all 39 native .cursor/rules copies are used in the build', () => {
    const native = R.listNativeRules(REPO_ROOT);
    assert.strictEqual(native.size, 39, `expected 39 native rules, found ${native.size}`);
    for (const [name, absPath] of native) {
      const builtPath = path.join(OUT_ROOT, 'rules', `${name}.mdc`);
      assert.ok(fs.existsSync(builtPath), `native rule missing in build: ${name}`);
      const nativeFm = T.splitFrontmatter(fs.readFileSync(absPath, 'utf8')).frontmatter;
      const builtFm = T.splitFrontmatter(fs.readFileSync(builtPath, 'utf8')).frontmatter;
      assert.strictEqual(builtFm, nativeFm, `frontmatter of ${name} differs from native copy`);
    }
  });

  // 5. alwaysApply: true exactly on the 10 common rules (PLAN.md section 2)
  t('alwaysApply: true on exactly the 10 common rules', () => {
    const always = listBuiltRules().filter(f => {
      const fm = T.splitFrontmatter(fs.readFileSync(path.join(OUT_ROOT, 'rules', f), 'utf8')).frontmatter;
      return T.getFrontmatterField(fm, 'alwaysApply') === 'true';
    });
    assert.strictEqual(always.length, 10, `expected 10, got ${always.length}: ${always.join(', ')}`);
    for (const f of always) assert.ok(f.startsWith('common-'), `${f} not a common rule`);
  });

  // 6. rule-internal links are flattened and resolvable
  t('no ../ rule links remain; flat rule links resolve inside the build', () => {
    const built = new Set(listBuiltRules().map(f => f.slice(0, -4)));
    for (const f of listBuiltRules()) {
      const content = fs.readFileSync(path.join(OUT_ROOT, 'rules', f), 'utf8');
      assert.ok(!/\]\(\.\.?\//.test(content.replace(/\]\(\.\.\/skills\//g, '')), `${f}: unresolved relative link`);
      const refs = content.match(/\]\(([\w-]+\.mdc)\)/g) || [];
      for (const ref of refs) {
        const name = ref.slice(2, -5);
        assert.ok(built.has(name), `${f}: link to missing rule ${name}`);
      }
    }
  });

  // 7. context skills
  t('3 ecc-context-* skills: name == folder, disable-model-invocation', () => {
    for (const id of ['dev', 'research', 'review']) {
      const name = `ecc-context-${id}`;
      const file = path.join(OUT_ROOT, 'skills', name, 'SKILL.md');
      assert.ok(fs.existsSync(file), `missing ${name}/SKILL.md`);
      const fm = T.splitFrontmatter(fs.readFileSync(file, 'utf8')).frontmatter;
      assert.ok(fm, `${name}: no frontmatter`);
      assert.strictEqual(T.getFrontmatterField(fm, 'name'), name, `${name}: name != folder`);
      assert.strictEqual(T.getFrontmatterField(fm, 'disable-model-invocation'), 'true', `${name}: not disable-model-invocation`);
      assert.ok(T.getFrontmatterField(fm, 'description'), `${name}: no description`);
    }
  });

  // 8. no rules/<ns>/<file>.md references left in any built markdown
  t('rules/<ns>/<file>.md references are rewritten to flat .mdc everywhere', () => {
    const namespaces = R.listRuleNamespaces(REPO_ROOT);
    const re = new RegExp(`rules\\/(?:${namespaces.join('|')})\\/[\\w-]+\\.md\\b`);
    const walk = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && /\.(md|mdc)$/.test(e.name)) {
          const content = fs.readFileSync(full, 'utf8');
          const m = content.match(re);
          assert.ok(!m, `${path.relative(OUT_ROOT, full)}: unrewritten ref ${m && m[0]}`);
        }
      }
    };
    walk(OUT_ROOT);
  });

  // 9. check-links: zero broken rule references against the build
  t('check-links: 0 broken rule targets', () => {
    const { checkLinks } = require('../../scripts/cursor-plugin/check-links');
    const { broken } = checkLinks();
    assert.strictEqual(broken.rules.size, 0, `broken rule refs: ${[...broken.rules.keys()].join(', ')}`);
  });

  // 10. determinism
  t('two builds are byte-identical (phase 2)', () => {
    const before = hashTree(OUT_ROOT);
    const r = runNode([path.join('scripts', 'cursor-plugin', 'build.js')]);
    assert.strictEqual(r.status, 0, `second build failed:\n${r.stderr}`);
    assert.strictEqual(hashTree(OUT_ROOT), before, 'build output differs between runs');
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
