'use strict';

/**
 * ECC Agent IR -> Cursor subagent emitter (phase 3, PLAN.md sections 2/8).
 * Modeled on scripts/lib/agent-emit-pi.js; sits on the same agent-ir parser.
 *
 * Cursor subagent format (cursor.com/docs/subagents, verified 22.11.2026):
 * markdown with YAML frontmatter; documented fields are `name` (defaults to
 * the filename), `description`, `model` (`inherit` or a model id),
 * `readonly` (bool, no file edits / state-changing shell) and
 * `is_background` (bool). Anything else from the Claude source frontmatter
 * (`tools`, `color`, ...) is dropped by allowlist - the same policy as
 * scripts/lib/install/copilot-agent.js, so future upstream keys cannot leak.
 *
 * Mapping decisions:
 *   - name: `ecc-<id>` (cursor-plugin/maps/agent-names.json); the file name
 *     equals the agent name, as scripts/lib/cursor-agent-names.js does.
 *   - model: always `inherit` (hard rule: no Claude model ids in the plugin).
 *     The source tier is not preserved anywhere - PLAN.md section 8 retires
 *     sonnet/opus/haiku mentions from plugin text; tiers are counted in the
 *     build report only.
 *   - tools: dropped from frontmatter (Cursor has no per-subagent allowlist;
 *     subagents inherit parent tools). The source list is rendered in the
 *     body as a "Recommended tools" paragraph with Cursor-equivalent names
 *     (tool-map.js). `mcp__*` tools are pulled out of the list and restated
 *     as an MCP-server requirement (PLAN.md section 8: context7/playwright
 *     belong in the project's .cursor/mcp.json; reference doc lands with the
 *     docs phase). Unknown tools are never silently dropped: they surface in
 *     `warnings` and are kept by name.
 *   - readonly: true exactly when every source tool is read-only
 *     (Read/Grep/Glob and equivalents - the 11 strict agents of PLAN.md).
 *   - is_background: not emitted (default false; no ECC agent needs it).
 *   - color: dropped (Claude-only presentation hint).
 */

const { mapTool, isReadonlyToolset, neutralizeMcpRefs } = require('./tool-map');

/**
 * Emit one Cursor subagent definition.
 *
 * @param {object} ir agent-ir object
 * @param {object} options
 * @param {Object<string,string>} options.nameMap bare id -> ecc-<id>
 * @param {(body: string) => string} [options.transformBody] body rewrite
 *   pipeline (rule refs, agent refs); applied to the IR body before assembly
 * @returns {{ markdown: string, warnings: string[], name: string, readonly: boolean, mcpServers: string[] }}
 */
function emitCursorAgent(ir, options = {}) {
  const warnings = [];
  const name = options.nameMap[ir.id];
  if (!name) {
    throw new Error(`${ir.id}: no entry in agent-names map`);
  }
  if (ir.name !== ir.id) {
    warnings.push(`${ir.id}: frontmatter name '${ir.name}' != filename; using filename`);
  }

  const readonly = isReadonlyToolset(ir.tools);
  const frontmatter = [
    '---',
    `name: ${yamlScalar(name)}`,
    `description: ${yamlScalar(ir.description)}`,
    'model: inherit',
    ...(readonly ? ['readonly: true'] : []),
    '---',
  ];

  const rawBody = (ir.body || '').replace(/^\n+/, '').trimEnd();
  const transformed = options.transformBody ? options.transformBody(rawBody, ir) : rawBody;
  const body = neutralizeMcpRefs(transformed);
  const toolsSection = renderToolsSection(ir, warnings);

  const markdown = `${frontmatter.join('\n')}\n\n${body}\n\n${toolsSection}\n`;
  return { markdown, warnings, name, readonly, mcpServers: mcpServersOf(ir) };
}

/** Distinct MCP servers referenced by the agent's tools (sorted). */
function mcpServersOf(ir) {
  const servers = new Set();
  for (const t of ir.tools) {
    const mapped = mapTool(t);
    if (mapped.kind === 'mcp') servers.add(mapped.server);
  }
  return [...servers].sort();
}

/** "Recommended tools" body section: Cursor names, MCP restated as requirement. */
function renderToolsSection(ir, warnings) {
  const native = [];
  const mcp = new Map(); // server -> Set of tool names
  for (const t of ir.tools) {
    const mapped = mapTool(t);
    if (mapped.kind === 'native') {
      const label = mapped.cursor === t ? mapped.cursor : `${mapped.cursor} (source \`${t}\`)`;
      if (!native.includes(label)) native.push(label);
    } else if (mapped.kind === 'mcp') {
      if (!mcp.has(mapped.server)) mcp.set(mapped.server, new Set());
      mcp.get(mapped.server).add(mapped.tool);
    } else {
      warnings.push(`${ir.id}: unmapped tool '${t}' kept by name in the Recommended tools list`);
      if (!native.includes(t)) native.push(t);
    }
  }

  const lines = [
    '## Recommended tools',
    '',
    `Cursor subagents inherit the parent's tool access${isReadonlyToolset(ir.tools) ? ' (this agent declares `readonly: true`)' : ''}; the source Claude \`tools:\` list is advisory here. Mapped to Cursor equivalents: ${native.join(', ')}.`,
  ];
  if (mcp.size > 0) {
    lines.push('');
    for (const server of [...mcp.keys()].sort()) {
      const tools = [...mcp.get(server)].sort().map(t => `\`${t}\``).join(', ');
      lines.push(`MCP tools required: ${tools} from the \`${server}\` MCP server. Add it to the project's \`.cursor/mcp.json\` (catalog: \`mcp-configs/mcp-servers.json\` in the ECC repo; reference doc ships with the plugin docs phase).`);
    }
  }
  return lines.join('\n');
}

/** Emit a single-line YAML scalar, quoted only when needed. */
function yamlScalar(value) {
  const s = String(value);
  if (/^\s|\s$|: |\n|\s#|^[-?*&|>#@`"'\][{}!,]/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

/**
 * Emit all agents, sorted by id for determinism.
 *
 * @param {object[]} irs
 * @param {object} options as in emitCursorAgent
 * @returns {{ results: object[], warnings: string[], stats: object }}
 */
function emitAllCursorAgents(irs, options = {}) {
  const results = [];
  const warnings = [];
  const readonlyAgents = [];
  const mcpServers = {};
  const modelTiers = {};

  for (const ir of [...irs].sort((a, b) => a.id.localeCompare(b.id))) {
    const { markdown, warnings: w, name, readonly, mcpServers: servers } = emitCursorAgent(ir, options);
    results.push({ id: ir.id, name, readonly, markdown });
    warnings.push(...w);
    if (readonly) readonlyAgents.push(ir.id);
    for (const s of servers) mcpServers[s] = (mcpServers[s] || 0) + 1;
    if (ir.model) modelTiers[ir.model] = (modelTiers[ir.model] || 0) + 1;
  }

  return {
    results,
    warnings,
    stats: {
      total: results.length,
      readonly: readonlyAgents.length,
      readonlyAgents: readonlyAgents.sort(),
      mcpServers,
      modelTiers,
    },
  };
}

module.exports = {
  emitCursorAgent,
  emitAllCursorAgents,
  yamlScalar,
};
