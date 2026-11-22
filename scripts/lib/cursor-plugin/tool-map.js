'use strict';

/**
 * Claude tool name -> Cursor tool mapping for the ecc-cursor agent emitter
 * (PLAN.md section 8). Separate table on purpose: scripts/lib/agent-tool-map.js
 * is the Pi/OpenCode map and must stay untouched (hard rule: upstream files
 * are not modified).
 *
 * Cursor subagents do not carry a `tools:` allowlist (cursor.com/docs/subagents
 * documents only name/description/model/readonly/is_background); they inherit
 * the parent's tools, restricted by `readonly: true`. The map is therefore
 * used to (a) decide `readonly` and (b) render the source tool list as
 * Cursor-equivalent names in the agent body.
 *
 * A tool is read-only when it cannot change files or run state-changing
 * commands: Read, Grep, Glob (and LS, which maps to Glob). MCP tools are
 * never treated as read-only: an MCP tool may have side effects the map
 * cannot see, and PLAN.md section 8 fixes the readonly set at exactly the 11
 * strict agents (tools subset of Read/Grep/Glob).
 */

const TOOL_MAP = Object.freeze({
  Read: { cursor: 'Read', readonly: true },
  Grep: { cursor: 'Grep', readonly: true },
  Glob: { cursor: 'Glob', readonly: true },
  LS: { cursor: 'Glob', readonly: true },
  Write: { cursor: 'Write', readonly: false },
  Edit: { cursor: 'Edit', readonly: false },
  MultiEdit: { cursor: 'Edit', readonly: false },
  NotebookEdit: { cursor: 'Edit', readonly: false },
  Bash: { cursor: 'Shell', readonly: false },
  WebSearch: { cursor: 'WebSearch', readonly: false },
  WebFetch: { cursor: 'WebFetch', readonly: false },
  Task: { cursor: 'Task', readonly: false },
  TodoWrite: { cursor: 'TodoWrite', readonly: false },
});

const MCP_TOOL_RE = /^mcp__([a-z0-9-]+)__(.+)$/i;

/**
 * Map one source tool name.
 * @returns {{ kind: 'native'|'mcp'|'unknown', cursor: string|null, readonly: boolean, server?: string, tool?: string }}
 */
function mapTool(name) {
  const mcp = MCP_TOOL_RE.exec(name);
  if (mcp) {
    return { kind: 'mcp', cursor: null, readonly: false, server: mcp[1], tool: mcp[2] };
  }
  const entry = TOOL_MAP[name];
  if (entry) {
    return { kind: 'native', cursor: entry.cursor, readonly: entry.readonly };
  }
  return { kind: 'unknown', cursor: null, readonly: false };
}

/**
 * Readonly iff every tool maps to a read-only native tool (PLAN.md section 8:
 * exactly the 11 strict agents qualify; MCP tools and anything unknown
 * disqualify conservatively).
 */
function isReadonlyToolset(tools) {
  return tools.length > 0 && tools.every(t => {
    const mapped = mapTool(t);
    return mapped.kind === 'native' && mapped.readonly;
  });
}

/**
 * Neutralize Claude-style `mcp__<server>__<tool>` mentions in body text
 * (PLAN.md section 8: "mcp__server__tool -> MCP tool <tool> of server
 * <server>"). Cursor never exposes tools under the mcp__ naming scheme, so
 * instructions referencing it would be dead weight. Surrounding backticks
 * are consumed and re-emitted balanced. Shared by the agent emitter (phase
 * 3) and the skill/command transforms (phases 4-5).
 */
function neutralizeMcpRefs(content) {
  return content.replace(/`?mcp__([a-z0-9-]+)__([a-z0-9_-]+)`?/gi, (m, server, tool) => `\`${tool}\` (\`${server}\` MCP)`);
}

module.exports = {
  TOOL_MAP,
  mapTool,
  isReadonlyToolset,
  neutralizeMcpRefs,
};
