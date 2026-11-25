'use strict';

/**
 * Phase-4 skill transforms for the ecc-cursor build.
 *
 * Upstream skills live in skills/<name>/ (SKILL.md plus nested markdown and
 * assets) with Claude-style frontmatter (allowed-tools, tools, argument-hint,
 * license, ...) and Claude paths in the body (.claude/, ${CLAUDE_PLUGIN_ROOT},
 * $ARGUMENTS). The Cursor plugin ships them as skills/<name>/... with native
 * Cursor frontmatter (name = folder, description, paths,
 * disable-model-invocation, metadata — cursor.com/docs/context/skills).
 *
 * The transform (SKILL.md and every nested .md):
 *   1. frontmatter: allowlist name/description/paths/disable-model-invocation/
 *      metadata; `allowed-tools` is restated in the body as a recommendation
 *      paragraph; `paths:` is injected for language/framework skills from the
 *      globs of the corresponding rules (PLAN.md section 2 mitigation for
 *      ~325 skills in context).
 *   2. body: per-skill literal overrides -> ordered path rules from
 *      cursor-plugin/maps/path-map.json (line-wise, skipping lines covered by
 *      the map's claudeAllowlist) -> rules/<ns>/<f>.md link flattening
 *      (phase 2) -> agent references -> ecc-* (phase 3, agent-refs.js) ->
 *      mcp__server__tool neutralization (phase 3, tool-map.js) -> Claude tool
 *      tokens (TodoWrite, MultiEdit, NotebookEdit, `Bash`) -> $ARGUMENTS.
 *
 * Sources are never modified; all rewriting happens on build content.
 */

const fs = require('fs');
const path = require('path');
const T = require('./transforms');
const R = require('./rules');
const { neutralizeMcpRefs } = require('./tool-map');

const FRONTMATTER_ALLOWLIST = new Set(['name', 'description', 'paths', 'disable-model-invocation', 'metadata']);
const ARGUMENTS_REPLACEMENT = 'the text after the skill name';

/**
 * Language/framework skill -> rule namespace mapping for `paths:` injection
 * (PLAN.md section 2: globs of the corresponding rules). Resolution order:
 * denylist -> exact alias -> prefix alias -> longest rule-namespace prefix.
 */
const SKILL_PATH_DENYLIST = new Set([
  // prefix-matches the `web` namespace but is a security-audit skill, not a
  // web-language skill
  'web-perimeter-owasp-2025-audit',
]);

const SKILL_PATH_EXACT = {
  'frontend-patterns': 'react',
  'frontend-a11y': 'react',
  'frontend-slides': 'web',
  'frontend-design-direction': 'web',
  'bun-runtime': 'typescript',
  'vite-patterns': 'typescript',
  'backend-patterns': 'typescript',
  'nodejs-keccak256': 'typescript',
  'nuxt4-patterns': 'nuxt',
  'nextjs-turbopack': 'react',
  'android-clean-architecture': 'kotlin',
  'compose-multiplatform-patterns': 'kotlin',
  'flutter-dart-code-review': 'dart',
};

const SKILL_PATH_PREFIX = {
  'django-': 'python',
  'fastapi-': 'python',
  'pytorch-': 'python',
  'laravel-': 'php',
  'rails-': 'ruby',
  'springboot-': 'java',
  'quarkus-': 'java',
  'motion-': 'react',
};

function loadPathMap(repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'cursor-plugin', 'maps', 'path-map.json'), 'utf8'));
}

/** Union of `paths:` globs across every rule in each rules/<ns>/ namespace. */
function collectNamespaceGlobs(repoRoot) {
  const map = {};
  for (const ns of R.listRuleNamespaces(repoRoot)) {
    const dir = path.join(repoRoot, 'rules', ns);
    const globs = new Set();
    const walk = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && e.name.endsWith('.md')) {
          const parts = T.splitFrontmatter(fs.readFileSync(full, 'utf8'));
          for (const g of R.parsePathsList(parts.frontmatter)) globs.add(g);
        }
      }
    };
    walk(dir);
    map[ns] = [...globs].sort();
  }
  return map;
}

/** Rule namespace whose globs apply to a skill, or null. */
function skillNamespace(skillName, namespaces) {
  if (SKILL_PATH_DENYLIST.has(skillName)) return null;
  if (SKILL_PATH_EXACT[skillName]) return SKILL_PATH_EXACT[skillName];
  for (const prefix of Object.keys(SKILL_PATH_PREFIX).sort((a, b) => b.length - a.length)) {
    if (skillName.startsWith(prefix)) return SKILL_PATH_PREFIX[prefix];
  }
  let best = null;
  for (const ns of namespaces) {
    if (skillName.startsWith(`${ns}-`) && (!best || ns.length > best.length)) best = ns;
  }
  return best;
}

/**
 * Remove frontmatter keys outside the Cursor allowlist, restating
 * `allowed-tools` for a body paragraph. Keys are top-level `key:` lines;
 * indented continuation lines belong to the preceding key (metadata blocks,
 * folded descriptions). When `paths` is non-empty it is injected right after
 * the description block.
 */
function sanitizeFrontmatter(frontmatter, { paths }) {
  const lines = frontmatter.split(/\r?\n/);
  const kept = [];
  const dropped = [];
  let allowedTools = null;
  let pathsInjected = false;
  // pre-scan: never duplicate an existing paths: block (idempotency)
  const hasExistingPaths = lines.some(l => /^paths:[ \t]/.test(l) || /^paths:\s*$/.test(l));
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^([A-Za-z][\w-]*):[ \t]*(.*)$/);
    if (!m) {
      kept.push(lines[i]);
      i += 1;
      continue;
    }
    const key = m[1];
    let j = i + 1;
    while (j < lines.length && /^\s/.test(lines[j])) j += 1;
    if (key === 'allowed-tools') {
      allowedTools = m[2].trim();
      dropped.push(key);
    } else if (FRONTMATTER_ALLOWLIST.has(key)) {
      kept.push(...lines.slice(i, j));
      if (key === 'description' && paths && paths.length > 0 && !pathsInjected && !hasExistingPaths) {
        kept.push('paths:');
        for (const g of paths) kept.push(`  - "${String(g).replace(/"/g, '\\"')}"`);
        pathsInjected = true;
      }
    } else {
      dropped.push(key);
    }
    i = j;
  }
  return { frontmatter: kept.join('\n'), dropped, allowedTools };
}

/** Restate a Claude allowed-tools list with Cursor-equivalent tool names. */
function restateAllowedTools(raw) {
  const mapped = raw
    .replace(/\bBash\b/g, 'Shell')
    .replace(/\bMultiEdit\b/g, 'Edit')
    .replace(/\bNotebookEdit\b/g, 'Edit');
  return [
    '',
    '',
    '## Recommended tools',
    '',
    `The source skill declared an \`allowed-tools\` list (a Claude Code-only key that Cursor does not read). Treat it as guidance, not enforcement: ${mapped}.`,
    '',
  ].join('\n');
}

function applyLiteral(content, from, to) {
  if (!from || !content.includes(from)) return { content, count: 0 };
  const count = content.split(from).length - 1;
  return { content: content.split(from).join(to), count };
}

/** Compiled path-map rules. `builtSkills` is closed over for builtSkillsOnly. */
function compilePathRules(pathMap, builtSkills) {
  return (pathMap.rules || []).map(rule => ({
    ...rule,
    re: rule.regex ? new RegExp(rule.regex, 'g') : null,
    builtSkills,
  }));
}

function applyPathRulesToLine(line, compiledRules) {
  let out = line;
  let replacements = 0;
  for (const rule of compiledRules) {
    if (rule.re) {
      rule.re.lastIndex = 0;
      out = out.replace(rule.re, (whole, ...groups) => {
        if (rule.builtSkillsOnly && !rule.builtSkills.has(groups[0])) return whole;
        replacements += 1;
        return rule.replace.replace(/\$(\d)/g, (m, idx) => groups[Number(idx) - 1]);
      });
    } else {
      const res = applyLiteral(out, rule.match, rule.replace);
      out = res.content;
      replacements += res.count;
    }
  }
  return { out, replacements };
}

function applyToolTokens(line) {
  let out = line;
  let replacements = 0;
  out = out.replace(/\bTodoWrite\b/g, () => { replacements += 1; return 'the agent task list'; });
  out = out.replace(/\bNotebookEdit\b/g, () => { replacements += 1; return 'Edit'; });
  out = out.replace(/\bMultiEdit\b/g, () => { replacements += 1; return 'Edit'; });
  out = out.replace(/`Bash`/g, () => { replacements += 1; return '`Shell`'; });
  let prev = null;
  while (prev !== out) {
    prev = out;
    out = out.replace(/Edit([/\\|])Edit/g, 'Edit$1');
  }
  return { out, replacements };
}

function lineSkippedByAllowlist(allowlist, componentName, line) {
  const entry = allowlist && allowlist[componentName];
  if (!entry) return false;
  if (entry.patterns.includes('*')) return true;
  return entry.patterns.some(pattern => line.includes(pattern));
}

/**
 * Create the skill markdown transform.
 *
 * @param {object} opts
 * @param {object} opts.pathMap cursor-plugin/maps/path-map.json content
 * @param {Set<string>} opts.builtSkills skill names present in the build
 * @param {Object<string,string[]>} opts.namespaceGlobs ns -> sorted globs
 * @param {string[]} opts.namespaces rule namespaces (longest-prefix match)
 * @param {(c: string) => string} opts.ruleRefs phase-2 rule link transform
 * @param {(c: string) => { content: string, replacements: number }} opts.agentRefs phase-3 transform
 * @returns {(content: string, ctx: { skillName: string, isSkillMd: boolean }) => { content: string, meta: object }}
 */
function createSkillTransform({ pathMap, builtSkills, namespaceGlobs, namespaces, ruleRefs, agentRefs }) {
  const rules = compilePathRules(pathMap, builtSkills);
  const overridesBySkill = new Map();
  for (const [skill, list] of Object.entries(pathMap.skillOverrides || {})) {
    overridesBySkill.set(skill, list);
  }
  const allowlist = pathMap.claudeAllowlist || {};

  return function transformSkillMarkdown(content, { skillName, isSkillMd }) {
    const meta = {
      changed: false,
      pathRewrites: 0,
      toolTokens: 0,
      overridesApplied: 0,
      droppedKeys: [],
      allowedToolsRestated: false,
      pathsAdded: 0,
      agentRefsRenamed: 0,
      agentRefsStructured: 0,
      mcpNeutralized: 0,
      argumentsRewritten: 0,
    };

    // 1. frontmatter
    const parts = T.splitFrontmatter(content);
    let body = parts.frontmatter ? parts.body.replace(/^\r?\n/, '') : content;
    let frontmatter = parts.frontmatter;
    let allowedTools = null;
    if (frontmatter !== null && frontmatter !== undefined) {
      const skillPaths = isSkillMd ? (namespaceGlobs[skillNamespace(skillName, namespaces)] || []) : [];
      const clean = sanitizeFrontmatter(frontmatter, { paths: skillPaths });
      frontmatter = clean.frontmatter;
      meta.droppedKeys = clean.dropped;
      allowedTools = clean.allowedTools;
      meta.allowedToolsRestated = Boolean(allowedTools);
      meta.pathsAdded = skillPaths.length;
    }

    // 2. per-skill literal overrides (before the global rules)
    for (const ov of overridesBySkill.get(skillName) || []) {
      const res = applyLiteral(body, ov.match, ov.replace);
      body = res.content;
      meta.overridesApplied += res.count;
    }

    // 3. ordered path rules + tool tokens, line-wise with allowlist skips
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (lineSkippedByAllowlist(allowlist, skillName, lines[i])) continue;
      const p = applyPathRulesToLine(lines[i], rules);
      const t = applyToolTokens(p.out);
      meta.pathRewrites += p.replacements;
      meta.toolTokens += t.replacements;
      lines[i] = t.out;
    }
    body = lines.join('\n');

    // 4. shared cross-component transforms (phases 2-3)
    body = ruleRefs(body);
    const renamed = agentRefs(body);
    body = renamed.content;
    meta.agentRefsRenamed += renamed.replacements;
    meta.agentRefsStructured += renamed.structuredReplacements || 0;
    const mcpCount = (body.match(/\bmcp__[a-z0-9-]+__[a-z0-9_-]+/gi) || []).length;
    body = neutralizeMcpRefs(body);
    meta.mcpNeutralized += mcpCount;

    // 5. $ARGUMENTS (Cursor does not substitute it)
    const args = applyLiteral(body, '$ARGUMENTS', ARGUMENTS_REPLACEMENT);
    body = args.content;
    meta.argumentsRewritten += args.count;

    if (allowedTools) {
      body = body.replace(/\s*$/, '') + restateAllowedTools(allowedTools);
    }

    let out = frontmatter !== null && frontmatter !== undefined
      ? `---\n${frontmatter}\n---\n${body}`
      : body;
    out = T.stripClaudeModelPins(out);
    meta.changed = out !== content;
    return { content: out, meta };
  };
}

module.exports = {
  FRONTMATTER_ALLOWLIST,
  ARGUMENTS_REPLACEMENT,
  SKILL_PATH_DENYLIST,
  SKILL_PATH_EXACT,
  SKILL_PATH_PREFIX,
  loadPathMap,
  collectNamespaceGlobs,
  skillNamespace,
  sanitizeFrontmatter,
  restateAllowedTools,
  applyLiteral,
  compilePathRules,
  applyPathRulesToLine,
  applyToolTokens,
  lineSkippedByAllowlist,
  createSkillTransform,
};
