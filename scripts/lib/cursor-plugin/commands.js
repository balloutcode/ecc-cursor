'use strict';

/**
 * Phase-5 command transform for the ecc-cursor build.
 *
 * Upstream commands are commands/<stem>.md with Claude frontmatter
 * (argument-hint, allowed-tools, model, ...) and Claude paths in the body.
 * Cursor command frontmatter is name + description only
 * (cursor.com/docs/reference/plugins, Commands format). Variant A from
 * PLAN.md: they stay commands, not skills.
 *
 * A command whose stem is also a skill directory is written as
 * ecc-<stem> (no slash namespace; forum 162287). Legacy shims in
 * cursor-plugin/overrides/commands/ keep their names (none collide).
 *
 * The six codeagent-wrapper commands are replaced wholesale from
 * cursor-plugin/overrides/command-bodies/ before this transform runs, so
 * the shared path / agent / argument passes still apply to the replacement.
 */

const fs = require('fs');
const path = require('path');
const T = require('./transforms');
const S = require('./skills');
const { neutralizeMcpRefs } = require('./tool-map');

const FRONTMATTER_KEYS = new Set(['name', 'description']);
const BODY_DIR = path.join('cursor-plugin', 'overrides', 'command-bodies');

function pluginCommandName(stem, skillNames) {
  if (skillNames && skillNames.has(stem)) return `ecc-${stem}`;
  return stem;
}

function unquote(raw) {
  const value = String(raw || '').trim();
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  return value;
}

function quoteYaml(value) {
  if (value === '') return '""';
  if (/[\n:#]/.test(value) || /:\s/.test(value) || /^[\s"'&*!|>%@`]/.test(value) || /[\s"'&*!|>%@`]$/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function parseBlocks(frontmatter) {
  const lines = frontmatter.split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const matched = lines[i].match(/^([A-Za-z][\w-]*):[ \t]*(.*)$/);
    if (!matched) {
      blocks.push({ key: null, lines: [lines[i]] });
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && /^\s/.test(lines[j])) j += 1;
    blocks.push({ key: matched[1], value: matched[2], lines: lines.slice(i, j) });
    i = j;
  }
  return blocks;
}

function blockText(block) {
  if (!block) return '';
  const first = unquote(block.value || '');
  const rest = block.lines.slice(1).map(line => line.trim()).filter(Boolean).map(unquote);
  return [first, ...rest].filter(Boolean).join(' ');
}

function buildFrontmatter({ pluginName, description, argumentHint }) {
  let desc = description || pluginName;
  const hint = argumentHint.trim();
  if (hint && !desc.includes(hint)) {
    const suffix = desc.endsWith('.') ? '' : '.';
    desc = `${desc}${suffix} Arguments: ${hint}.`;
  }
  return `name: ${pluginName}\ndescription: ${quoteYaml(desc)}`;
}

function loadReplacement(repoRoot, stem) {
  const abs = path.join(repoRoot, BODY_DIR, `${stem}.md`);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8');
}

function applyOverrides(body, list) {
  let out = body;
  let count = 0;
  for (const ov of list || []) {
    const res = S.applyLiteral(out, ov.match, ov.replace);
    out = res.content;
    count += res.count;
  }
  return { content: out, count };
}

function applyArguments(body, pluginName) {
  if (!body.includes('$ARGUMENTS')) return { body, count: 0 };
  const count = body.split('$ARGUMENTS').length - 1;
  const inline = `the text after \`/${pluginName}\``;
  let next = body.split('$ARGUMENTS').join(inline);
  if (!next.includes('## Arguments')) {
    const block = [
      '## Arguments',
      '',
      `Arguments: the text the user wrote after \`/${pluginName}\`.`,
      '',
    ].join('\n');
    const heading = next.match(/^#[^\n]*\n+/);
    if (heading) {
      const at = heading.index + heading[0].length;
      next = `${next.slice(0, at)}${block}${next.slice(at)}`;
    } else {
      next = `${block}${next}`;
    }
  }
  return { body: next, count };
}

/**
 * Rewrite /<old> to /<plugin name> for skill-name collisions.
 * Applied to command files only: /<skill> in skills still names the skill.
 *
 * @param {Object<string,string>} renames stem -> plugin command name
 */
function createSlashRewriter(renames) {
  const entries = Object.entries(renames || {}).sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]));
  if (entries.length === 0) return content => ({ content, count: 0 });
  const map = Object.fromEntries(entries);
  const re = new RegExp(`(?<![\\w-])/(${entries.map(([name]) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`, 'g');
  return content => {
    let count = 0;
    re.lastIndex = 0;
    const out = content.replace(re, (match, name) => {
      count += 1;
      return `/${map[name]}`;
    });
    return { content: out, count };
  };
}

/**
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {object} opts.pathMap
 * @param {Set<string>} opts.builtSkills
 * @param {(content: string) => string} opts.ruleRefs
 * @param {(content: string) => { content: string, replacements: number, structuredReplacements?: number }} opts.agentRefs
 * @param {Object<string,string>} opts.renames collision stem -> plugin command name
 */
function createCommandTransform(opts) {
  const rules = S.compilePathRules(opts.pathMap, opts.builtSkills);
  const allowlist = opts.pathMap.commandAllowlist || {};
  const overrides = opts.pathMap.commandOverrides || {};
  const rewriteSlash = createSlashRewriter(opts.renames);

  return function transformCommand(content, ctx) {
    const meta = {
      changed: false,
      pathRewrites: 0,
      toolTokens: 0,
      overridesApplied: 0,
      droppedKeys: [],
      argumentHintsFolded: 0,
      argumentsRewritten: 0,
      agentRefsRenamed: 0,
      agentRefsStructured: 0,
      mcpNeutralized: 0,
      slashRewrites: 0,
      bodyReplaced: false,
      allowedToolsRestated: false,
    };

    const replacement = loadReplacement(opts.repoRoot, ctx.commandName);
    const normalized = (replacement || content).replace(/\r\n/g, '\n');
    meta.bodyReplaced = Boolean(replacement);
    const overridden = applyOverrides(normalized, overrides[ctx.commandName]);
    const source = overridden.content;
    meta.overridesApplied += overridden.count;

    const parts = T.splitFrontmatter(source);
    const blocks = parts.frontmatter ? parseBlocks(parts.frontmatter) : [];
    const byKey = new Map(blocks.filter(block => block.key).map(block => [block.key, block]));
    let description = blockText(byKey.get('description'));
    const argumentHint = blockText(byKey.get('argument-hint'));
    const allowedTools = blockText(byKey.get('allowed-tools'));
    const agentField = blockText(byKey.get('agent'));
    if (argumentHint) meta.argumentHintsFolded = 1;
    meta.droppedKeys = [...new Set(blocks.map(block => block.key).filter(key => key && !FRONTMATTER_KEYS.has(key)))].sort();

    if (description && !S.lineSkippedByAllowlist(allowlist, ctx.commandName, description)) {
      const rewritten = S.applyPathRulesToLine(description, rules);
      const tools = S.applyToolTokens(rewritten.out);
      description = tools.out;
      meta.pathRewrites += rewritten.replacements;
      meta.toolTokens += tools.replacements;
    }
    if (description) {
      const renamedDesc = opts.agentRefs(description);
      description = renamedDesc.content;
      meta.agentRefsRenamed += renamedDesc.replacements;
      meta.agentRefsStructured += renamedDesc.structuredReplacements || 0;
    }

    let body = parts.frontmatter ? parts.body.replace(/^\n/, '') : source;

    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (S.lineSkippedByAllowlist(allowlist, ctx.commandName, lines[i])) continue;
      const rewritten = S.applyPathRulesToLine(lines[i], rules);
      const tools = S.applyToolTokens(rewritten.out);
      meta.pathRewrites += rewritten.replacements;
      meta.toolTokens += tools.replacements;
      lines[i] = tools.out;
    }
    body = lines.join('\n');

    body = opts.ruleRefs(body);
    const renamed = opts.agentRefs(body);
    body = renamed.content;
    meta.agentRefsRenamed += renamed.replacements;
    meta.agentRefsStructured += renamed.structuredReplacements || 0;
    const mcpCount = (body.match(/\bmcp__[a-z0-9-]+__[a-z0-9_-]+/gi) || []).length;
    body = neutralizeMcpRefs(body);
    meta.mcpNeutralized += mcpCount;

    if (agentField) {
      body = `Delegate this command to \`${agentField}\`.\n\n${body}`;
      const delegated = opts.agentRefs(body);
      body = delegated.content;
      meta.agentRefsRenamed += delegated.replacements;
      meta.agentRefsStructured += delegated.structuredReplacements || 0;
    }

    const args = applyArguments(body, ctx.pluginName);
    body = args.body;
    meta.argumentsRewritten += args.count;

    if (allowedTools) {
      body = body.replace(/\s*$/, '') + S.restateAllowedTools(allowedTools);
      meta.allowedToolsRestated = true;
    }

    const frontmatter = buildFrontmatter({
      pluginName: ctx.pluginName,
      description,
      argumentHint,
    });
    let out = `---\n${frontmatter}\n---\n${body.startsWith('\n') ? body : body}`;
    if (!out.endsWith('\n')) out += '\n';
    const slashed = rewriteSlash(out);
    out = slashed.content;
    meta.slashRewrites += slashed.count;
    if (out.includes('$ARGUMENTS')) {
      const leftover = out.split('$ARGUMENTS').length - 1;
      meta.argumentsRewritten += leftover;
      out = out.split('$ARGUMENTS').join(`the text after \`/${ctx.pluginName}\``);
    }
    out = T.stripClaudeModelPins(out);
    meta.changed = out !== content;
    return { content: out, meta };
  };
}

module.exports = {
  BODY_DIR,
  pluginCommandName,
  createSlashRewriter,
  createCommandTransform,
  loadReplacement,
};
