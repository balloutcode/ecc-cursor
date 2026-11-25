'use strict';

/**
 * Phase-2 rule transforms for the ecc-cursor build.
 *
 * Upstream rules live in rules/<namespace>/<file>.md with Claude-style
 * frontmatter (`paths:`). The Cursor plugin ships them flattened as
 * rules/<namespace>-<file>.mdc with native Cursor frontmatter
 * (description / globs / alwaysApply), mirroring the naming of
 * createFlatRuleOperations in scripts/lib/install-targets/helpers.js.
 *
 * When a native Cursor copy exists in .cursor/rules/<flat>.md (39 files
 * upstream), it wins: its frontmatter and body are the curated Cursor
 * variant. Body link fixes (relative rule links, .claude path retargets)
 * still apply on top of the native copy.
 *
 * Sources are never modified; all rewriting happens on build content.
 */

const fs = require('fs');
const path = require('path');
const T = require('./transforms');

const NATIVE_RULES_DIR = path.join('.cursor', 'rules');

/** Map of flat rule name (no extension) -> absolute native copy path. */
function listNativeRules(repoRoot) {
  const dir = path.join(repoRoot, NATIVE_RULES_DIR);
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort()) {
    map.set(f.slice(0, -3), path.join(dir, f));
  }
  return map;
}

/** Namespace directories under rules/ (sorted, deterministic). */
function listRuleNamespaces(repoRoot) {
  const dir = path.join(repoRoot, 'rules');
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
}

/** Parse a `paths:` YAML list out of Claude-style rule frontmatter. */
function parsePathsList(frontmatter) {
  if (!frontmatter) return [];
  const lines = frontmatter.split(/\r?\n/);
  const globs = [];
  let inPaths = false;
  for (const line of lines) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths) {
      const item = line.match(/^\s+-\s+(.+?)\s*$/);
      if (item) {
        globs.push(item[1].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'));
        continue;
      }
      break; // next top-level field ends the list
    }
  }
  return globs;
}

/** First markdown H1 text, or null. */
function extractH1(body) {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].replace(/[#*`[\]]/g, '').trim() : null;
}

/** YAML double-quoted scalar. */
function yamlQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Rewrite rule-body references that break once rules are flattened into
 * the plugin's rules/ directory:
 *   ](../common/<f>.md)      -> ](common-<f>.mdc)
 *   ](../<ns>/<f>.md)        -> ](<ns>-<f>.mdc)
 *   ](./<f>.md)              -> ](<ns>-<f>.mdc)   (same-namespace sibling)
 *   ](../../skills/<rest>)   -> ](../skills/<rest>)  (plugin layout depth)
 *   `~/.claude/settings.json` -> `~/.cursor/ecc/setup.json` (hook config)
 *   `.claude/settings.json`   -> `.cursor/hooks.json` (project hook config)
 *   `~/.claude/agents/`       -> plugin agents directory
 *   ~/.claude/rules/ecc/<ns>/<f>.md -> <ns>-<f> rule name
 */
function transformRuleBody(body, namespace) {
  let out = body;
  out = out.replace(/\]\(\.\.\/([\w-]+)\/([\w-]+\.md)\)/g, (m, ns, f) => `](${ns}-${f.replace(/\.md$/, '.mdc')})`);
  out = out.replace(/\]\(\.\/([\w-]+\.md)\)/g, (m, f) => `](${namespace}-${f.replace(/\.md$/, '.mdc')})`);
  out = out.replace(/\]\(\.\.\/\.\.\/skills\//g, '](../skills/');
  out = out.replace(/~\/\.claude\/settings\.json/g, '~/.cursor/ecc/setup.json');
  out = out.replace(/(?<!~\/)`?\.claude\/settings\.json`?/g, '`.cursor/hooks.json`');
  out = out.replace(/`~\/\.claude\/agents\/`/g, "the plugin's `agents/` directory");
  out = out.replace(/~\/\.claude\/agents\//g, "the plugin's agents/ directory");
  out = out.replace(/~?\.claude\/rules\/ecc\/([\w-]+)\/([\w-]+)\.md/g, (m, ns, f) => `${ns}-${f}`);
  out = out.replace(/\.claude\/rules\/([\w-]+)\/([\w-]+)\.md/g, (m, ns, f) => `${ns}-${f}`);
  return out;
}

/**
 * Build a Cursor-format rule document from an upstream rule.
 * Returns { content, meta } where meta carries report data.
 *
 * `agentRefs` (phase 3): optional transform from agent-refs.js applied to the
 * rule body (native copies included - the native common-agents copy uses bare
 * names) after the phase-2 link fixes. Bare agent references are renamed to
 * the plugin's ecc-* agents; the replacement count lands in meta.
 */
function transformRule({ namespace, relFile, content, nativeContent, agentRefs }) {
  const applyAgentRefs = body => {
    if (!agentRefs) return { body, agentRefReplacements: 0, agentRefStructured: 0 };
    const r = agentRefs(body);
    return {
      body: r.content,
      agentRefReplacements: r.replacements,
      agentRefStructured: r.structuredReplacements || 0,
    };
  };

  if (nativeContent !== null && nativeContent !== undefined) {
    const parts = T.splitFrontmatter(nativeContent);
    const frontmatter = parts.frontmatter || '';
    const renamed = applyAgentRefs(transformRuleBody(parts.frontmatter ? parts.body.replace(/^\r?\n/, '') : nativeContent, namespace));
    const alwaysApply = T.getFrontmatterField(frontmatter, 'alwaysApply') === 'true';
    return {
      content: `---\n${frontmatter}\n---\n${renamed.body}`,
      meta: {
        source: 'native',
        description: T.getFrontmatterField(frontmatter, 'description'),
        alwaysApply,
        globs: parsePathsList(frontmatter.replace(/^globs:/m, 'paths:')).length || null,
        agentRefReplacements: renamed.agentRefReplacements,
        agentRefStructured: renamed.agentRefStructured,
      },
    };
  }

  const parts = T.splitFrontmatter(content);
  const globs = parsePathsList(parts.frontmatter);
  const renamed = applyAgentRefs(transformRuleBody(parts.frontmatter ? parts.body.replace(/^\r?\n/, '') : content, namespace));
  const h1 = extractH1(renamed.body);
  const description = h1 || `ECC ${namespace} rules (${relFile.replace(/\.md$/, '')})`;
  // PLAN.md section 2: alwaysApply true for the 10 common rules (as in
  // .cursor/rules); false whenever globs are present.
  const alwaysApply = namespace === 'common';

  const lines = ['---', `description: ${yamlQuote(description)}`];
  if (globs.length > 0) {
    lines.push('globs:');
    for (const g of globs) lines.push(`  - ${yamlQuote(g)}`);
  }
  lines.push(`alwaysApply: ${alwaysApply}`);
  lines.push('---', '');

  return {
    content: `${lines.join('\n')}${renamed.body}`,
    meta: {
      source: 'upstream',
      description,
      alwaysApply,
      globs: globs.length,
      hadFrontmatter: Boolean(parts.frontmatter),
      agentRefReplacements: renamed.agentRefReplacements,
      agentRefStructured: renamed.agentRefStructured,
    },
  };
}

/**
 * Rewrite `rules/<ns>/<file>.md` references inside any built markdown
 * component (skills, commands, agents) to the flattened plugin name
 * `rules/<ns>-<file>.mdc`. Relative prefixes (../, ../../) are kept: the
 * plugin ships rules/ at its root, exactly like the repo.
 */
function createRuleRefTransform(namespaces) {
  const nsAlt = namespaces.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // Boundary: a preceding '/' is fine (relative prefixes like ../../rules/),
  // only word chars / hyphen must not precede (avoids matching longer names).
  const re = new RegExp(`(?<![\\w-])rules\\/(${nsAlt})\\/([\\w-]+)\\.md\\b`, 'g');
  return content => content.replace(re, (m, ns, f) => `rules/${ns}-${f}.mdc`);
}

/**
 * Generate a context skill (skills/ecc-context-<id>/SKILL.md) from
 * contexts/<id>.md. In Claude Code contexts load via --system-prompt; in
 * Cursor they ship as explicitly-invoked skills (Custom Mode emulation).
 */
function buildContextSkill(id, content) {
  const name = `ecc-context-${id}`;
  const titles = { dev: 'development', research: 'research', review: 'code review' };
  const title = titles[id] || id;
  let body = content.replace(/\r\n/g, '\n').replace(/\n+$/, '\n');
  // Minimal tool-name neutralization for Cursor (full pass is phases 4-5).
  body = body.replace(/^- Bash for /m, '- Shell for ');
  body = body.replace(/^- Task with Explore agent for /m, '- Subagent delegation (explore-type) for ');
  return [
    '---',
    `name: ${name}`,
    `description: ${yamlQuote(`ECC ${title} mode context (port of contexts/${id}.md). Invoke explicitly with /${name} to switch the agent into this working mode.`)}`,
    'disable-model-invocation: true',
    '---',
    '',
    body,
  ].join('\n');
}

module.exports = {
  listNativeRules,
  listRuleNamespaces,
  parsePathsList,
  extractH1,
  transformRuleBody,
  transformRule,
  createRuleRefTransform,
  buildContextSkill,
};
