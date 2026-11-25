/**
 * Phase-5 tests for the ecc-cursor build: command transform and link fail mode.
 *
 * Run with: node tests/cursor-plugin/commands.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_ROOT = path.join(REPO_ROOT, 'build', 'cursor-plugin', 'ecc-cursor');
const REPORT_PATH = path.join(REPO_ROOT, 'build', 'cursor-plugin', 'report.json');
const C = require('../../scripts/lib/cursor-plugin/commands');
const S = require('../../scripts/lib/cursor-plugin/skills');
const R = require('../../scripts/lib/cursor-plugin/rules');
const T = require('../../scripts/lib/cursor-plugin/transforms');
const N = require('../../scripts/lib/cursor-plugin/agent-names');
const { createAgentRefTransform } = require('../../scripts/lib/cursor-plugin/agent-refs');
const { checkLinks } = require('../../scripts/cursor-plugin/check-links');

const COLLISIONS = [
  'ecc-guide', 'issue-review', 'marketing-campaign', 'orch-add-feature', 'orch-build-mvp',
  'orch-change-feature', 'orch-fix-defect', 'orch-refine-code', 'plan-canvas', 'security-scan',
  'skill-host-compat', 'token-card',
];
const WRAPPER_COMMANDS = ['multi-backend', 'multi-execute', 'multi-frontend', 'multi-plan', 'multi-workflow', 'santa-loop'];
const SHIMS = ['api', 'backend', 'docs', 'e2e', 'eval', 'frontend', 'memory', 'mle', 'research', 'security-audit', 'tdd', 'verify'];

function runNode(args) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', cwd: REPO_ROOT, timeout: 120000 });
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
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
    }
  };
  walk(root);
  return out;
}

function makeTransform(skillNames) {
  const names = skillNames || new Set(COLLISIONS);
  const renames = {};
  for (const stem of names) renames[stem] = C.pluginCommandName(stem, names);
  const namespaces = R.listRuleNamespaces(REPO_ROOT);
  return C.createCommandTransform({
    repoRoot: REPO_ROOT,
    pathMap: S.loadPathMap(REPO_ROOT),
    builtSkills: names,
    ruleRefs: R.createRuleRefTransform(namespaces),
    agentRefs: createAgentRefTransform(N.loadAgentNameMap(REPO_ROOT)),
    renames,
  });
}

function runTests() {
  console.log('\n=== Testing cursor-plugin commands transform (phase 5) ===\n');
  let passed = 0;
  let failed = 0;
  const t = (name, fn) => (test(name, fn) ? passed++ : failed++);

  t('plugin command names: skill collisions gain an ecc- prefix', () => {
    const skills = new Set(['plan-canvas', 'ecc-guide', 'tdd']);
    assert.strictEqual(C.pluginCommandName('plan', skills), 'plan');
    assert.strictEqual(C.pluginCommandName('plan-canvas', skills), 'ecc-plan-canvas');
    assert.strictEqual(C.pluginCommandName('ecc-guide', skills), 'ecc-ecc-guide');
    assert.strictEqual(C.pluginCommandName('tdd', new Set()), 'tdd');
  });

  t('$ARGUMENTS becomes an Arguments block; argument-hint folds into description', () => {
    const tr = makeTransform(new Set());
    const src = [
      '---',
      'description: Review the change',
      'argument-hint: "[pr-number | blank]"',
      'model: opus',
      '---',
      '# Review',
      '',
      'Scope: $ARGUMENTS',
      '',
    ].join('\n');
    const once = tr(src, { commandName: 'code-review', pluginName: 'code-review' });
    const twice = tr(once.content, { commandName: 'code-review', pluginName: 'code-review' });
    assert.strictEqual(twice.content, once.content, 'command transform is not idempotent');
    assert.ok(!once.content.includes('$ARGUMENTS'), 'token survived');
    assert.ok(!once.content.includes('argument-hint:'), 'argument-hint survived');
    assert.ok(!/model:\s*["']?opus/.test(once.content), 'model pin survived');
    assert.ok(once.content.includes('name: code-review'), 'name missing');
    assert.ok(once.content.includes('Arguments: [pr-number | blank].'), 'hint not folded');
    assert.ok(once.content.includes('## Arguments'), 'arguments block missing');
    assert.ok(once.content.includes('the text the user wrote after `/code-review`'), 'block wording missing');
    assert.ok(once.content.includes('the text after `/code-review`'), 'inline wording missing');
    assert.strictEqual(once.meta.argumentHintsFolded, 1);
    assert.strictEqual(once.meta.argumentsRewritten, 1);
  });

  t('slash collisions inside commands are renamed; prose planner is not', () => {
    const tr = makeTransform(new Set(['plan-canvas']));
    const src = '---\ndescription: Use /plan-canvas after /plan\n---\n\nThe planner notebook stays. Use `planner` for the agent.\n';
    const out = tr(src, { commandName: 'notes', pluginName: 'notes' }).content;
    assert.ok(out.includes('/ecc-plan-canvas'), out);
    assert.ok(out.includes('/plan\n') || out.includes('/plan`') || out.includes('after /plan'), out);
    assert.ok(!out.includes('/plan-canvas'), out);
    assert.ok(out.includes('The planner notebook stays'), out);
    assert.ok(out.includes('`ecc-planner`'), out);
    const again = tr(out, { commandName: 'notes', pluginName: 'notes' }).content;
    assert.strictEqual(again, out, 'slash rewrite is not idempotent');
  });

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

  t('report: 110 commands, 12 collisions, 12 shims, 6 wrapper bodies, 15 argument hints', () => {
    assert.strictEqual(report.phase, 5);
    assert.strictEqual(report.counts.commands.total, 110);
    assert.strictEqual(report.counts.commands.upstream, 98);
    assert.strictEqual(report.counts.commands.overrides, 12);
    assert.deepStrictEqual(report.commands.collisions.map(c => c.from), COLLISIONS);
    assert.deepStrictEqual(report.commands.collisions.map(c => c.to), COLLISIONS.map(name => `ecc-${name}`));
    assert.deepStrictEqual(report.commands.legacyShims, SHIMS);
    assert.deepStrictEqual(report.commands.bodiesReplaced, WRAPPER_COMMANDS);
    assert.strictEqual(report.commands.argumentHintsFolded, 15);
    assert.ok(report.commands.argumentsRewritten > 0, 'no $ARGUMENTS rewrites');
    assert.ok(report.commands.pathRewrites > 0, 'no path rewrites');
    assert.ok(report.commands.agentRefsRenamed > 0, 'no agent refs');
    assert.ok(report.commands.agentRefsStructured > 0, 'no structured agent refs in commands');
    assert.ok(report.skills.agentRefsStructured > 0, 'no structured agent refs in skills');
    const structured = report.rules.renamedAgentRefsStructured
      + report.agents.renamedRefsStructured
      + report.skills.agentRefsStructured
      + report.commands.agentRefsStructured;
    assert.ok(structured > 0, 'structured agent-ref total is 0');
  });

  const commandsDir = path.join(OUT_ROOT, 'commands');
  const builtCommands = new Set(fs.readdirSync(commandsDir).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)));
  const builtSkills = new Set(fs.readdirSync(path.join(OUT_ROOT, 'skills'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name));

  t('built commands: name matches file, no Claude command tokens, collisions renamed', () => {
    for (const name of COLLISIONS) {
      assert.ok(!builtCommands.has(name), `colliding command kept its skill name: ${name}`);
      assert.ok(builtCommands.has(`ecc-${name}`), `missing renamed command ecc-${name}`);
      assert.ok(builtSkills.has(name), `skill removed while renaming the command: ${name}`);
    }
    for (const file of walkMd(commandsDir)) {
      const content = fs.readFileSync(file, 'utf8');
      const base = path.basename(file, '.md');
      const fm = T.splitFrontmatter(content).frontmatter;
      assert.strictEqual(T.getFrontmatterField(fm, 'name'), base, file);
      assert.ok(T.getFrontmatterField(fm, 'description'), `no description: ${base}`);
      assert.ok(!content.includes('$ARGUMENTS'), `$ARGUMENTS in ${base}`);
      assert.ok(!content.includes('codeagent-wrapper'), `codeagent-wrapper in ${base}`);
      assert.ok(!content.includes('.ccg/prompts'), `.ccg/prompts in ${base}`);
      assert.ok(!content.includes('${CLAUDE_PLUGIN_ROOT}'), `plugin root var in ${base}`);
      assert.ok(!/\bmodel:\s*["']?(?:sonnet|opus|haiku|fable)(?![\w-])/i.test(content), `model pin in ${base}`);
    }
  });

  t('wrapper commands delegate to plugin subagents and do not name Codex or Antigravity', () => {
    for (const name of WRAPPER_COMMANDS) {
      const content = fs.readFileSync(path.join(commandsDir, `${name}.md`), 'utf8');
      assert.ok(content.includes('own environment'), `${name} does not say own environment`);
      assert.ok(/`ecc-[a-z0-9-]+`/.test(content), `${name} names no ecc- subagent`);
      assert.ok(!/Codex|Antigravity|antigravity/.test(content), `${name} still names an external model CLI`);
    }
  });

  t('legacy shims alias a skill that is in the build', () => {
    for (const name of SHIMS) {
      const content = fs.readFileSync(path.join(commandsDir, `${name}.md`), 'utf8');
      const tokens = content.split(/[^a-z0-9-]+/).filter(token => builtSkills.has(token));
      assert.ok(tokens.length > 0, `${name} does not name a built skill`);
    }
  });

  t('.claude/ in commands only on the command allowlist', () => {
    const allowlist = S.loadPathMap(REPO_ROOT).commandAllowlist;
    for (const file of walkMd(commandsDir)) {
      const base = path.basename(file, '.md');
      const stem = base.startsWith('ecc-') && COLLISIONS.includes(base.slice(4)) ? base.slice(4) : base;
      const lines = fs.readFileSync(file, 'utf8').split(/\n/);
      lines.forEach((line, i) => {
        if (!line.includes('.claude/')) return;
        const entry = allowlist[stem];
        const ok = entry && (entry.patterns.includes('*') || entry.patterns.some(p => line.includes(p)));
        assert.ok(ok, `.claude/ outside command allowlist: ${base}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    for (const [stem, entry] of Object.entries(allowlist)) {
      const pluginName = COLLISIONS.includes(stem) ? `ecc-${stem}` : stem;
      const content = fs.readFileSync(path.join(commandsDir, `${pluginName}.md`), 'utf8');
      for (const pattern of entry.patterns) {
        assert.ok(content.includes(pattern), `command allowlist stale for ${stem}: '${pattern}'`);
      }
    }
  });

  t('node scripts referenced by built commands are in the build', () => {
    const scriptRe = /(?:^|[\s"'`(=])((?:\.{1,2}\/)?scripts\/[\w@+.,~/-]+\.(?:js|cjs|mjs))\b/g;
    const missing = [];
    for (const file of walkMd(commandsDir)) {
      const content = fs.readFileSync(file, 'utf8');
      let matched;
      while ((matched = scriptRe.exec(content)) !== null) {
        let ref = matched[1];
        if (ref.startsWith('./')) ref = ref.slice(2);
        if (ref.startsWith('../')) continue;
        if (!fs.existsSync(path.join(OUT_ROOT, ref))) missing.push(`${ref} <- ${path.basename(file)}`);
      }
    }
    assert.deepStrictEqual(missing, []);
  });

  t('plan-prd -> plan -> tdd-workflow -> code-review -> pr nodes exist and name real agents', () => {
    const requiredCommands = ['plan-prd', 'plan', 'code-review', 'pr'];
    for (const name of requiredCommands) assert.ok(builtCommands.has(name), `missing command ${name}`);
    assert.ok(builtSkills.has('tdd-workflow'), 'missing tdd-workflow skill');
    const plan = fs.readFileSync(path.join(commandsDir, 'plan.md'), 'utf8');
    const review = fs.readFileSync(path.join(commandsDir, 'code-review.md'), 'utf8');
    const agentsDir = path.join(OUT_ROOT, 'agents');
    assert.ok(plan.includes('ecc-planner'), 'plan does not name ecc-planner');
    assert.ok(fs.existsSync(path.join(agentsDir, 'ecc-planner.md')));
    assert.ok(review.includes('ecc-code-reviewer') && review.includes('ecc-security-reviewer'));
    assert.ok(fs.existsSync(path.join(agentsDir, 'ecc-code-reviewer.md')));
    assert.ok(fs.existsSync(path.join(agentsDir, 'ecc-security-reviewer.md')));
    assert.ok(!plan.includes('Codex') && !plan.includes('Antigravity'), 'plan still points at external model CLIs');
    const docs = [
      plan,
      review,
      fs.readFileSync(path.join(commandsDir, 'plan-prd.md'), 'utf8'),
      fs.readFileSync(path.join(commandsDir, 'pr.md'), 'utf8'),
      fs.readFileSync(path.join(OUT_ROOT, 'skills', 'tdd-workflow', 'SKILL.md'), 'utf8'),
    ].join('\n');
    const slashRe = /(?:^|[\s`'"(])\/([a-z][a-z0-9-]{1,40})\b/g;
    const repoCommands = new Set(fs.readdirSync(path.join(REPO_ROOT, 'commands')).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)));
    const broken = new Set();
    let matched;
    while ((matched = slashRe.exec(docs)) !== null) {
      const name = matched[1];
      if (!repoCommands.has(name)) continue;
      if (builtCommands.has(name) || builtSkills.has(name)) continue;
      broken.add(name);
    }
    assert.deepStrictEqual([...broken], []);
  });

  t('phase-4 bare agent names in skills are rewritten in the structured contexts', () => {
    const prompt = fs.readFileSync(path.join(OUT_ROOT, 'skills', 'prompt-optimizer', 'SKILL.md'), 'utf8');
    const pipeline = fs.readFileSync(path.join(OUT_ROOT, 'skills', 'opensource-pipeline', 'SKILL.md'), 'utf8');
    const brown = fs.readFileSync(path.join(OUT_ROOT, 'skills', 'brownfield-retrospective', 'SKILL.md'), 'utf8');
    const orch = fs.readFileSync(path.join(OUT_ROOT, 'skills', 'orch-add-feature', 'SKILL.md'), 'utf8');
    const orchestrate = fs.readFileSync(path.join(OUT_ROOT, 'skills', 'plan-orchestrate', 'SKILL.md'), 'utf8');
    const tdd = fs.readFileSync(path.join(OUT_ROOT, 'skills', 'tdd-workflow', 'SKILL.md'), 'utf8');
    assert.ok(prompt.includes('ecc-planner, ecc-tdd-guide, ecc-code-reviewer'), 'prompt-optimizer table not rewritten');
    assert.ok(!pipeline.includes('subagent_type="opensource-forker"'), 'bare subagent_type survived');
    assert.ok(pipeline.includes('subagent_type="ecc-opensource-forker"'));
    assert.ok(brown.includes('ecc-planner (scope the row)'));
    assert.ok(orch.includes('ecc-security-reviewer'));
    assert.ok(orchestrate.includes('ecc-tdd-guide') && orchestrate.includes('ecc-python-reviewer'));
    assert.ok(tdd.includes('Prefer `.ecc/tdd/` when the project has no documentation directory of its own.'));
    assert.ok(!tdd.includes('Claude-specific local artifacts, the `.ecc/tdd/`'), 'tdd sentence still contradicts itself');
    const spec = fs.readFileSync(path.join(OUT_ROOT, 'agents', 'ecc-spec-miner.md'), 'utf8');
    assert.ok(spec.includes('Auto-extracted by spec-miner.'), 'output signature was rewritten');
  });

  t('command path fixes: plugin fallback, project skills, homunculus, agent data home', () => {
    const read = name => fs.readFileSync(path.join(commandsDir, `${name}.md`), 'utf8');
    const installed = '%USERPROFILE%/.cursor/plugins/local/ecc-cursor/skills/continuous-learning-v2/scripts/instinct-cli.py';
    for (const name of ['evolve', 'instinct-import', 'prune', 'promote', 'projects']) {
      const text = read(name);
      assert.ok(text.includes(installed), `${name} fallback is not the installed plugin copy`);
      assert.ok(text.includes('use the installed plugin copy'), `${name} prose still describes a manual Claude install`);
      assert.ok(!text.includes('CLAUDE_PLUGIN_ROOT'), `${name} still names CLAUDE_PLUGIN_ROOT`);
      assert.ok(text.includes('$ECC_PLUGIN_ROOT/skills/continuous-learning-v2/scripts/instinct-cli.py'), `${name} primary invocation lost ECC_PLUGIN_ROOT`);
    }
    const status = read('instinct-status');
    assert.ok(status.includes('legacy `~/.claude/skills/continuous-learning-v2/`'), 'legacy skill warning was rewritten');
    assert.ok(status.includes('`ECC_PLUGIN_ROOT`'), 'instinct-status prose still says CLAUDE_PLUGIN_ROOT');
    assert.ok(!status.includes('CLAUDE_PLUGIN_ROOT'), 'instinct-status still names CLAUDE_PLUGIN_ROOT');
    assert.ok(status.includes('~/.local/share/ecc-homunculus/projects/'), 'instinct-status store was not aligned');
    assert.ok(!status.includes('<ECC_AGENT_DATA_HOME>/homunculus'), 'instincts were sent to agent data home');
    for (const name of ['evolve', 'instinct-import', 'promote', 'projects']) {
      const text = read(name);
      assert.ok(text.includes('~/.local/share/ecc-homunculus'), `${name} homunculus path not aligned`);
      assert.ok(!text.includes('~/.claude/homunculus') && !text.includes('<ECC_AGENT_DATA_HOME>/homunculus'), `${name} homunculus path still wrong`);
    }
    const learn = read('learn-eval');
    const created = read('skill-create');
    assert.ok(learn.includes('`.cursor/skills/<pattern-name>/SKILL.md` in current project'), 'learn-eval project skills path');
    assert.ok(created.includes('`.cursor/skills/`'), 'skill-create project root');
    assert.ok(!learn.includes('.ecc/skills/') && !created.includes('.ecc/skills/'), 'project skills became .ecc/skills');
    const cost = read('cost-report');
    assert.ok(cost.includes('process.env.ECC_AGENT_DATA_HOME'), 'cost-report snippet ignores ECC_AGENT_DATA_HOME');
    assert.ok(cost.includes('".cursor","ecc"'), 'cost-report snippet misses the Cursor agent-data default');
    assert.ok(!cost.includes('".claude"'), 'cost-report snippet still joins .claude');
    const quoted = /['"]\.claude['"]/;
    const slashCollision = /(?:^|[\s`"(])\/(?:plan-canvas|ecc-guide)(?![\w-])/m;
    for (const file of walkMd(commandsDir)) {
      const text = fs.readFileSync(file, 'utf8');
      const base = path.basename(file);
      assert.ok(!quoted.test(text), `${base} still has a quoted .claude path`);
      assert.ok(!slashCollision.test(text), `${base} still has /plan-canvas or /ecc-guide`);
    }
    const cli = path.join(OUT_ROOT, 'skills', 'continuous-learning-v2', 'scripts', 'instinct-cli.py');
    assert.ok(fs.existsSync(cli), 'plugin skill script instinct-cli.py missing');
  });

  t('check-links fail mode exits 0 with no broken targets', () => {
    const { total } = checkLinks();
    assert.strictEqual(total, 0, `broken targets: ${total}`);
    const cli = runNode([path.join('scripts', 'cursor-plugin', 'check-links.js')]);
    assert.strictEqual(cli.status, 0, `check-links failed:\n${cli.stdout}\n${cli.stderr}`);
  });

  t('validate.js and generate-hooks --check exit 0', () => {
    const validate = runNode([path.join('scripts', 'cursor-plugin', 'validate.js')]);
    assert.strictEqual(validate.status, 0, validate.stderr);
    const hooks = runNode([path.join('scripts', 'cursor-plugin', 'generate-hooks.js'), '--check']);
    assert.strictEqual(hooks.status, 0, `generate-hooks --check:\n${hooks.stdout}\n${hooks.stderr}`);
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
