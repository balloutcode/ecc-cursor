'use strict';

/**
 * Rewrites references to ECC agents inside built markdown bodies to the
 * plugin's `ecc-<id>` names, using cursor-plugin/maps/agent-names.json.
 *
 * Only unambiguous reference contexts are rewritten; plain-prose occurrences
 * of agent names that double as ordinary words ("senior software architect",
 * "network architecture planner") are deliberately left alone. Contexts:
 *
 *   P1  `ecc:<name>` (Claude plugin-scoped id)          -> `ecc-<name>`
 *   P6  `subagent_type: "<name>"` (Claude Task syntax)  -> `subagent_type: "ecc-<name>"`
 *   P2  `` `<name>` `` (backticked id)                  -> `` `ecc-<name>` ``
 *   P3  `**<name>**` (bold id)                          -> `**ecc-<name>**`
 *   P4  `@<name>` (mention, not email-like)             -> `@ecc-<name>`
 *   P5  `| <name> |` (whole table cell)                 -> `| ecc-<name> |`
 *   P7  `<name> agent` / `<name> subagent`              -> `ecc-<name> agent`
 *   P8  heading ending in `vs <name>`                   -> `vs ecc-<name>`
 *   P9  `Run <name>` / `run <name>`                     -> `Run ecc-<name>`
 *
 * Every pattern guards with (?<![\w-]) (or delimiters) so an already-renamed
 * `ecc-<name>` never matches again: the transform is idempotent, and names
 * that are suffixes of other names (`architect` in `homelab-architect`) only
 * match at real boundaries (alternation is longest-first).
 *
 * Known bare leftovers (intentionally untouched, resolved by check-links via
 * the name map): self-signatures inside output templates ("Auto-extracted by
 * spec-miner", "opensource-sanitizer v1.0.0") and plain-prose self mentions
 * ("for code-explorer to jump to").
 */

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {Object<string,string>} nameMap bare id -> ecc-<id>
 * @returns {(content: string) => { content: string, replacements: number }}
 */
function createAgentRefTransform(nameMap) {
  const alt = Object.keys(nameMap)
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map(escapeRe)
    .join('|');
  const to = name => nameMap[name];

  const rules = [
    // P1 ecc:<name> -> ecc-<name>
    { re: new RegExp(`(?<![\\w-])ecc:(${alt})(?![\\w-])`, 'g'), sub: (m, n) => to(n) },
    // P6 subagent_type: "<name>" / '<name>' / <name>
    { re: new RegExp(`(subagent_type:\\s*["']?)(${alt})(?=["',\\s)])`, 'g'), sub: (m, pre, n) => `${pre}${to(n)}` },
    // P2 `<name>`
    { re: new RegExp(`\`(${alt})\``, 'g'), sub: (m, n) => `\`${to(n)}\`` },
    // P3 **<name>**
    { re: new RegExp(`\\*\\*(${alt})\\*\\*`, 'g'), sub: (m, n) => `**${to(n)}**` },
    // P4 @<name> (the @ must not follow a word char, dot or hyphen: no e-mails, no npm scopes)
    { re: new RegExp(`(?<![\\w@.-])@(${alt})(?![\\w-])`, 'g'), sub: (m, n) => `@${to(n)}` },
    // P5 | <name> | whole table cell
    { re: new RegExp(`\\|(\\s*)(${alt})(\\s*)\\|`, 'g'), sub: (m, l, n, r) => `|${l}${to(n)}${r}|` },
    // P7 <name> agent / <name> subagent
    { re: new RegExp(`(?<![\\w-])(${alt})(?= (?:agent|subagent)\\b)`, 'g'), sub: (m, n) => to(n) },
    // P8 markdown heading ending in "vs <name>"
    { re: new RegExp(`(^#{1,6}[^\\n]*?\\bvs )(${alt})(?=[ \\t]*\\r?$)`, 'gm'), sub: (m, pre, n) => `${pre}${to(n)}` },
    // P9 Run <name> / run <name>
    { re: new RegExp(`\\b([Rr]un )(${alt})(?![\\w-])`, 'g'), sub: (m, pre, n) => `${pre}${to(n)}` },
  ];

  return content => {
    let replacements = 0;
    let out = content;
    for (const { re, sub } of rules) {
      out = out.replace(re, (...args) => {
        replacements += 1;
        return sub(...args);
      });
    }
    return { content: out, replacements };
  };
}

module.exports = { createAgentRefTransform };
