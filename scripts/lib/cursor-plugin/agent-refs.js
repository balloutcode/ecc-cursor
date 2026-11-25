'use strict';

/**
 * Rewrites references to ECC agents inside built markdown bodies to the
 * plugin's `ecc-<id>` names, using cursor-plugin/maps/agent-names.json.
 *
 * Only unambiguous reference contexts are rewritten. Plain-prose occurrences
 * of short names that are also ordinary words ("senior software architect",
 * "the planner notebook", "the planner, architect, and team") stay bare.
 *
 * Legacy contexts (phase 3):
 *   P1  `ecc:<name>`                         -> `ecc-<name>`
 *   P2  `<name>`                             -> `ecc-<name>`
 *   P3  **<name>**                           -> **ecc-<name>**
 *   P4  @<name>                              -> @ecc-<name>
 *   P5  | <name> |   (whole table cell)      -> | ecc-<name> |
 *   P6  subagent_type: "<name>"              -> subagent_type: "ecc-<name>"
 *   P7  <name> agent / <name> subagent
 *   P8  heading ending in `vs <name>`
 *   P9  Run <name>
 *
 * Structured contexts added in phase 5 (counted separately):
 *   P6b subagent_type="<name>"               (attribute form, no colon)
 *   P10 agents/<name>.md                     -> agents/ecc-<name>.md
 *   P11 comma-separated table cell of agent ids (including short names)
 *   P12 diagram / chain line: optional arrow, then an agent id, then
 *       end-of-line, a parenthetical, or " + ..."
 *   P13 comma-separated list that contains at least one hyphenated agent id
 *   P14 any remaining hyphenated agent id (identifiers, not English words)
 *
 * Exclusions for P14: `by spec-miner` output-template signatures, and any
 * agent id immediately followed by ` v<digit>` (version banners such as
 * `opensource-sanitizer v1.0.0`). `ecc-pubmed-search` and similar tokens
 * stay intact because `(?<![\w-])` / `(?![\w-])` refuse to match inside a
 * longer hyphenated token.
 *
 * Alternation is longest-first, so `architect` does not match inside
 * `homelab-architect`, and an already-renamed `ecc-<name>` never matches
 * again. The transform is idempotent.
 */

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sortedAlt(names) {
  return names
    .slice()
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map(escapeRe)
    .join('|');
}

/**
 * @param {Object<string,string>} nameMap bare id -> ecc-<id>
 * @returns {(content: string) => { content: string, replacements: number, structuredReplacements: number }}
 */
function createAgentRefTransform(nameMap) {
  const names = Object.keys(nameMap);
  const alt = sortedAlt(names);
  const hyphenated = names.filter(name => name.includes('-'));
  const hyphenAlt = sortedAlt(hyphenated);
  const to = name => nameMap[name];

  const legacyRules = [
    { re: new RegExp(`(?<![\\w-])ecc:(${alt})(?![\\w-])`, 'g'), sub: (m, n) => to(n) },
    { re: new RegExp(`(subagent_type:\\s*["']?)(${alt})(?=["',\\s)])`, 'g'), sub: (m, pre, n) => `${pre}${to(n)}` },
    { re: new RegExp(`\`(${alt})\``, 'g'), sub: (m, n) => `\`${to(n)}\`` },
    { re: new RegExp(`\\*\\*(${alt})\\*\\*`, 'g'), sub: (m, n) => `**${to(n)}**` },
    { re: new RegExp(`(?<![\\w@.-])@(${alt})(?![\\w-])`, 'g'), sub: (m, n) => `@${to(n)}` },
    { re: new RegExp(`\\|(\\s*)(${alt})(\\s*)\\|`, 'g'), sub: (m, l, n, r) => `|${l}${to(n)}${r}|` },
    { re: new RegExp(`(?<![\\w-])(${alt})(?= (?:agent|subagent)\\b)`, 'g'), sub: (m, n) => to(n) },
    { re: new RegExp(`(^#{1,6}[^\\n]*?\\bvs )(${alt})(?=[ \\t]*\\r?$)`, 'gm'), sub: (m, pre, n) => `${pre}${to(n)}` },
    { re: new RegExp(`\\b([Rr]un )(${alt})(?![\\w-])`, 'g'), sub: (m, pre, n) => `${pre}${to(n)}` },
  ];

  const structuredRes = [
    {
      re: new RegExp(`(subagent_type\\s*=\\s*["'])(${alt})(?=["'])`, 'g'),
      sub: (m, pre, n) => `${pre}${to(n)}`,
    },
    {
      re: new RegExp(`(agents/)(${alt})(\\.md\\b)`, 'g'),
      sub: (m, pre, n, suf) => `${pre}${to(n)}${suf}`,
    },
  ];

  function rewriteTableCells(content) {
    let count = 0;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\s*\|/.test(lines[i])) continue;
      const parts = lines[i].split('|');
      let changed = false;
      for (let c = 0; c < parts.length; c += 1) {
        const cell = parts[c];
        const trimmed = cell.trim();
        if (!trimmed.includes(',')) continue;
        const items = trimmed.split(/\s*,\s*/);
        if (items.length < 2 || items.some(item => !nameMap[item])) continue;
        const lead = cell.match(/^\s*/)[0];
        const trail = cell.match(/\s*$/)[0];
        parts[c] = `${lead}${items.map(item => nameMap[item]).join(', ')}${trail}`;
        count += items.length;
        changed = true;
      }
      if (changed) lines[i] = parts.join('|');
    }
    return { content: lines.join('\n'), count };
  }

  function rewriteDiagrams(content) {
    const lineRe = new RegExp(`^(\\s*(?:→|->|=>)\\s*|\\s*)(${alt})(?![\\w-])(.*)$`);
    let count = 0;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes('|')) continue;
      const matched = lines[i].match(lineRe);
      if (!matched || !nameMap[matched[2]]) continue;
      const hasArrow = /^\s*(?:→|->|=>)/.test(lines[i]);
      const restOk = /^\s*\(/.test(matched[3]) || /^\s*\+/.test(matched[3]);
      if (!hasArrow && !restOk) continue;
      lines[i] = `${matched[1]}${nameMap[matched[2]]}${matched[3]}`;
      count += 1;
    }
    return { content: lines.join('\n'), count };
  }

  function rewriteHyphenatedLists(content) {
    const re = new RegExp(`(?<![\\w-])((?:${alt})(?:\\s*,\\s*(?:and\\s+)?(?:${alt}))+)(?![\\w-])`, 'g');
    let count = 0;
    const out = content.replace(re, match => {
      const items = match.split(/\s*,\s*(?:and\s+)?/).filter(Boolean);
      if (items.length < 2 || items.some(item => !nameMap[item])) return match;
      if (!items.some(item => item.includes('-'))) return match;
      count += items.length;
      return items.map(item => nameMap[item]).join(', ');
    });
    return { content: out, count };
  }

  function rewriteHyphenatedBare(content) {
    if (!hyphenAlt) return { content, count: 0 };
    const re = new RegExp(`(?<![\\w-])(${hyphenAlt})(?![\\w-])`, 'g');
    let count = 0;
    const out = content.replace(re, (match, name, offset, str) => {
      const after = str.slice(offset + match.length);
      if (/^ v\d/.test(after)) return match;
      if (name === 'spec-miner' && /by $/.test(str.slice(0, offset))) return match;
      count += 1;
      return nameMap[name];
    });
    return { content: out, count };
  }

  function applyRules(content, rules) {
    let count = 0;
    let out = content;
    for (const { re, sub } of rules) {
      re.lastIndex = 0;
      out = out.replace(re, (...args) => {
        count += 1;
        return sub(...args);
      });
    }
    return { content: out, count };
  }

  return content => {
    const legacy = applyRules(content, legacyRules);
    const attribute = applyRules(legacy.content, structuredRes);
    const tables = rewriteTableCells(attribute.content);
    const diagrams = rewriteDiagrams(tables.content);
    const lists = rewriteHyphenatedLists(diagrams.content);
    const bare = rewriteHyphenatedBare(lists.content);
    const structured = attribute.count + tables.count + diagrams.count + lists.count + bare.count;
    return {
      content: bare.content,
      replacements: legacy.count + structured,
      structuredReplacements: structured,
    };
  };
}

module.exports = { createAgentRefTransform };
