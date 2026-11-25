'use strict';

/**
 * Content transforms for the ecc-cursor build.
 *
 * Phase 1 is an IDENTITY build: source bytes pass through unchanged, with a
 * single deliberate exception - agent frontmatter `model:` is rewritten to
 * `model: inherit` (hard rule: the plugin must not ship Claude model ids;
 * also `sonnet|opus|haiku` are not valid Cursor model values, so without
 * this the probe plugin's agents would not load). The real transform set
 * (paths->globs, path-map, ecc-* names, tool-map) lands in phases 2-5.
 */

const FORBIDDEN_MODEL_PATTERN = /\b(sonnet|opus|haiku|fable)\b|claude-[a-z0-9-]*/i;

function identity(content) {
  return content;
}

/** Split "---\n<frontmatter>\n---\n<body>" without a YAML parser. */
function splitFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: null, body: content, raw: null };
  return {
    frontmatter: match[1],
    body: content.slice(match[0].length),
    raw: match[0],
  };
}

function getFrontmatterField(frontmatter, field) {
  if (!frontmatter) return null;
  const re = new RegExp(`^${field}:[ \\t]*(.*)$`, 'm');
  const match = frontmatter.match(re);
  return match ? match[1].trim() : null;
}

/** Rewrite `model:` inside agent frontmatter to `model: inherit`. */
function agentModelInherit(content) {
  const parts = splitFrontmatter(content);
  if (!parts.frontmatter) return content;
  if (!/^model:[ \t]*.*$/m.test(parts.frontmatter)) return content;
  const updated = parts.frontmatter.replace(/^model:[ \t]*.*$/m, 'model: inherit');
  return `---\n${updated}\n---\n${parts.body.replace(/^\r?\n/, '')}`;
}

/** Drop Claude model pins (`model: opus`, `model: "fable"`, ...) from built text. */
function stripClaudeModelPins(content) {
  return content.replace(/\bmodel:\s*["']?(?:sonnet|opus|haiku|fable)(?![\w-])["']?/gi, 'model: inherit');
}

function hasForbiddenModel(content) {
  const parts = splitFrontmatter(content);
  const model = getFrontmatterField(parts.frontmatter, 'model');
  return model ? FORBIDDEN_MODEL_PATTERN.test(model) : false;
}

/**
 * Flat rule file name, mirroring createFlatRuleOperations in
 * scripts/lib/install-targets/helpers.js: rules/<ns>/<file>.md ->
 * <ns>-<file>.mdc (nested segments joined with '-'). README.md -> null.
 */
function flattenRuleName(namespace, relativeFile) {
  if (relativeFile.toLowerCase() === 'readme.md' || relativeFile.toLowerCase().endsWith('/readme.md')) {
    return null;
  }
  const flat = `${namespace}-${relativeFile.replace(/\//g, '-')}`;
  return flat.endsWith('.md') ? `${flat.slice(0, -3)}.mdc` : flat;
}

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

module.exports = {
  identity,
  splitFrontmatter,
  getFrontmatterField,
  agentModelInherit,
  stripClaudeModelPins,
  hasForbiddenModel,
  flattenRuleName,
  toPosix,
  FORBIDDEN_MODEL_PATTERN,
};
