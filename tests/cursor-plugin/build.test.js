/**
 * Phase-1 tests for the ecc-cursor build skeleton.
 *
 * Run with: node tests/cursor-plugin/build.test.js
 * (picked up by tests/run-all.js; ECC_TEST_ONLY=cursor-plugin selects it)
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_ROOT = path.join(REPO_ROOT, 'build', 'cursor-plugin', 'ecc-cursor');
const REPORT_PATH = path.join(REPO_ROOT, 'build', 'cursor-plugin', 'report.json');
const RUN_JS = path.join(REPO_ROOT, 'cursor-plugin', 'hooks-src', 'run.js');
const PROBE_JS = path.join(REPO_ROOT, 'cursor-plugin', 'hooks-src', 'probe.js');

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

function listRel(root, filter) {
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const rel = path.relative(root, full).replace(/\\/g, '/');
        if (!filter || filter(rel)) out.push(rel);
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

// Test helper (repo style)
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
  console.log('\n=== Testing cursor-plugin build (phase 1) ===\n');
  let passed = 0;
  let failed = 0;
  const t = (name, fn) => (test(name, fn) ? passed++ : failed++);

  // 1. build runs
  let report = null;
  t('build.js exits 0', () => {
    const r = runNode([path.join('scripts', 'cursor-plugin', 'build.js')]);
    assert.strictEqual(r.status, 0, `build failed:\n${r.stderr}\n${r.stdout}`);
    assert.ok(fs.existsSync(REPORT_PATH), 'report.json missing');
    report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
  });
  if (!report) {
    console.log(`\n=== ${passed} passed, ${++failed} failed ===\n`);
    process.exit(1);
  }

  // 2. report counts match phase-1 expectations (PLAN.md section 11)
  t('report counts: rules 121, agents 72, skills 322, commands 98+12=110', () => {
    assert.strictEqual(report.counts.rules, 121);
    assert.strictEqual(report.counts.agents, 72);
    assert.strictEqual(report.counts.skills, 322);
    assert.strictEqual(report.counts.commands.upstream, 98);
    assert.strictEqual(report.counts.commands.overrides, 12);
    assert.strictEqual(report.counts.commands.total, 110);
  });

  t('report: scripts closure < 150 files, hooks 4 events x 2 forms', () => {
    assert.ok(report.counts.scripts > 0, 'closure empty');
    assert.ok(report.counts.scripts < 150, `closure too big: ${report.counts.scripts}`);
    assert.strictEqual(report.counts.hooks.events, 4);
    assert.strictEqual(report.counts.hooks.entries, 8);
  });

  t('report: orchestration override recorded, exclusions recorded', () => {
    assert.deepStrictEqual(report.modules.targetOverrides.orchestration.addTargets, ['cursor']);
    for (const s of ['hermes-imports', 'openclaw-persona-forge', 'deepseek-harness-setup', 'config-health', 'dmux-workflows']) {
      assert.ok(report.excluded.skills[s], `missing exclusion reason for ${s}`);
    }
  });

  // 3. excluded content is absent from the build
  t('excluded skills and platform scripts are not in the build', () => {
    for (const s of ['hermes-imports', 'openclaw-persona-forge', 'deepseek-harness-setup', 'config-health', 'dmux-workflows']) {
      assert.ok(!fs.existsSync(path.join(OUT_ROOT, 'skills', s)), `excluded skill present: ${s}`);
    }
    const all = listRel(OUT_ROOT);
    for (const rel of all) {
      assert.ok(!/^(\.kiro|\.opencode|\.codex|\.hermes|\.kimi|\.gemini|\.qwen|\.zed|\.trae|\.adal|\.openclaw|\.codebuddy|\.grok-plugin|\.qoder-plugin|\.agents|pi)\//.test(rel), `platform path in build: ${rel}`);
      assert.ok(!/^scripts\/(codex|codex-git-hooks)\//.test(rel), `codex script in build: ${rel}`);
      assert.ok(!/^scripts\/(build-opencode|build-pi-core|grok-install|gemini-adapt-agents|qwen-adapt-agents)\.js$/.test(rel), `platform script in build: ${rel}`);
    }
  });

  // 4. manifest validity (plugin checklist)
  t('plugin.json: kebab name, relative existing paths, agents model inherit', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(OUT_ROOT, '.cursor-plugin', 'plugin.json'), 'utf8'));
    assert.ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.name), `bad name ${manifest.name}`);
    for (const key of ['rules', 'agents', 'skills', 'commands', 'hooks', 'mcpServers']) {
      const v = manifest[key];
      assert.ok(typeof v === 'string' && v, `${key} missing`);
      assert.ok(!path.isAbsolute(v) && !v.split(/[\\/]/).includes('..'), `${key} not relative: ${v}`);
      assert.ok(fs.existsSync(path.join(OUT_ROOT, v)), `${key} target missing: ${v}`);
    }
    const agentsDir = path.join(OUT_ROOT, 'agents');
    for (const f of fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'))) {
      const content = fs.readFileSync(path.join(agentsDir, f), 'utf8');
      assert.ok(!/\bmodel:\s*(sonnet|opus|haiku|fable)\b/.test(content), `forbidden model in ${f}`);
      assert.ok(/\bmodel:\s*inherit\b/.test(content) || !/\bmodel:/.test(content), `model not inherit in ${f}`);
    }
  });

  t('validate.js exits 0', () => {
    const r = runNode([path.join('scripts', 'cursor-plugin', 'validate.js')]);
    assert.strictEqual(r.status, 0, `validate failed:\n${r.stderr}\n${r.stdout}`);
  });

  // 5. determinism
  t('two builds are byte-identical', () => {
    const before = hashTree(OUT_ROOT);
    const reportBefore = fs.readFileSync(REPORT_PATH, 'utf8');
    const r = runNode([path.join('scripts', 'cursor-plugin', 'build.js')]);
    assert.strictEqual(r.status, 0, `second build failed:\n${r.stderr}`);
    assert.strictEqual(hashTree(OUT_ROOT), before, 'build output differs between runs');
    assert.strictEqual(fs.readFileSync(REPORT_PATH, 'utf8'), reportBefore, 'report.json differs between runs');
  });

  // 6. LICENSE in the build
  t('LICENSE is included', () => {
    assert.ok(fs.existsSync(path.join(OUT_ROOT, 'LICENSE')));
  });

  // 7. hooks.json shape + --check
  t('hooks.json: 4 events x 2 command forms; generate-hooks --check OK', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(OUT_ROOT, 'hooks', 'hooks.json'), 'utf8'));
    for (const event of ['sessionStart', 'preToolUse', 'stop', 'subagentStop']) {
      assert.ok(Array.isArray(hooks.hooks[event]), `missing event ${event}`);
      assert.strictEqual(hooks.hooks[event].length, 2, `${event} must have both forms`);
      const [a, b] = hooks.hooks[event];
      assert.ok(a.command.includes('-e'), 'form A must use node -e');
      assert.ok(b.command.startsWith('node ./hooks/'), 'form B must use node ./hooks/');
    }
    assert.strictEqual(hooks.hooks.preToolUse[0].matcher, '*');
    const r = runNode([path.join('scripts', 'cursor-plugin', 'generate-hooks.js'), '--check']);
    assert.strictEqual(r.status, 0, `--check failed:\n${r.stderr}\n${r.stdout}`);
  });

  // 8. run.js event resolution in both argv forms
  t('run.js takes the event as argv.at(-1) in both command forms', () => {
    const run = require(RUN_JS);
    assert.strictEqual(run.resolveEvent(['node', 'sessionStart']), 'sessionStart'); // form A
    assert.strictEqual(run.resolveEvent(['node', 'C:\\p\\hooks\\run.js', 'stop']), 'stop'); // form B
    assert.strictEqual(run.resolveProjectDir({ CURSOR_PROJECT_DIR: 'X:\\proj' }, null, 'C:\\cwd'), 'X:\\proj');
    assert.strictEqual(run.resolveProjectDir({}, { workspace_roots: ['Y:\\ws'] }, 'C:\\cwd'), 'Y:\\ws');
    assert.strictEqual(run.resolveProjectDir({}, { workspace_roots: ['/c:/Users/u/ws'] }, 'C:\\cwd'), 'c:/Users/u/ws');
    assert.strictEqual(run.resolveProjectDir({}, null, 'C:\\cwd'), 'C:\\cwd');

    const formB = runNode([RUN_JS, 'preToolUse'], { input: '{}' });
    assert.strictEqual(formB.status, 0, `run.js form B failed: ${formB.stderr}`);
    const formA = runNode(['-e', `require(${JSON.stringify(RUN_JS.replace(/\\/g, '/'))})`, 'stop'], { input: '{}' });
    assert.strictEqual(formA.status, 0, `run.js form A failed: ${formA.stderr}`);
  });

  // 9. probe.js logs both command forms
  t('probe.js logs event/argv/cwd/env for both forms, exit 0', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-probe-'));
    const env = { ECC_PROBE_HOME: home, CURSOR_PLUGIN_ROOT: 'X:\\plugin', CURSOR_PROJECT_DIR: 'Y:\\proj' };
    const payload = JSON.stringify({ workspace_roots: ['Y:\\proj'], hook_event_name: 'stop' });

    const rB = runNode([PROBE_JS, 'stop'], { env, input: payload });
    assert.strictEqual(rB.status, 0, `probe form B failed: ${rB.stderr}`);
    const rA = runNode(['-e', `require(${JSON.stringify(PROBE_JS.replace(/\\/g, '/'))})`, 'sessionStart'], { env, input: payload });
    assert.strictEqual(rA.status, 0, `probe form A failed: ${rA.stderr}`);

    const log = fs.readFileSync(path.join(home, '.cursor', 'ecc', 'probe.log'), 'utf8').trim().split('\n').map(JSON.parse);
    const byForm = Object.fromEntries(log.map(r => [r.argvForm, r]));
    assert.ok(byForm.B && byForm.A, `both forms must log, got: ${log.map(r => r.argvForm)}`);
    assert.strictEqual(byForm.B.event, 'stop');
    assert.strictEqual(byForm.A.event, 'sessionStart');
    assert.strictEqual(byForm.A.env.CURSOR_PLUGIN_ROOT, 'X:\\plugin');
    assert.deepStrictEqual(byForm.B.payload.workspace_roots, ['Y:\\proj']);
    fs.rmSync(home, { recursive: true, force: true });
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
