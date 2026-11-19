#!/usr/bin/env node
/**
 * ecc-cursor hook dispatcher (phase-1 skeleton).
 *
 * Every entry in the plugin's hooks.json will call this dispatcher with the
 * Cursor event name (phase 6 wires the real hook-ids). Contract:
 *
 * - Event name is ALWAYS process.argv.at(-1). Command form A
 *   (node -e "require(...run.js)" <event>) delivers it as argv[1]; form B
 *   (node ./hooks/run.js <event>) as argv[2]. Never rely on argv position.
 * - Never depend on cwd: stop/subagentStop run with cwd = workspace root,
 *   other events with cwd = plugin folder. The plugin root comes from
 *   process.env.CURSOR_PLUGIN_ROOT.
 * - Legacy ECC scripts keep working unmodified: we export CLAUDE_PLUGIN_ROOT
 *   and ECC_PLUGIN_ROOT (both = CURSOR_PLUGIN_ROOT) plus CLAUDE_PROJECT_DIR
 *   (resolved project dir) before dispatching.
 * - Always exit 0 in phase 1; blocking decisions arrive with phase 6.
 */

'use strict';

const STDIN_BUDGET_MS = 1500;

/** Event name is the last argv token in both command forms. */
function resolveEvent(argv) {
  return (argv && argv.length ? argv[argv.length - 1] : '') || '';
}

/**
 * Project dir chain (PLAN.md section 5): CURSOR_PROJECT_DIR -> first
 * workspace_roots entry from the hook payload -> process.cwd(). For
 * stop/subagentStop the cwd IS the workspace root, so the last branch is
 * still correct there.
 */
function resolveProjectDir(env, payload, cwd) {
  if (env && typeof env.CURSOR_PROJECT_DIR === 'string' && env.CURSOR_PROJECT_DIR) {
    return env.CURSOR_PROJECT_DIR;
  }
  if (payload && Array.isArray(payload.workspace_roots) && payload.workspace_roots.length > 0) {
    const first = payload.workspace_roots[0];
    if (typeof first === 'string' && first) return first;
  }
  return cwd || process.cwd();
}

/** Export the env aliases legacy ECC scripts resolve their roots from. */
function setupEnv(env, projectDir) {
  const pluginRoot = env.CURSOR_PLUGIN_ROOT;
  if (pluginRoot) {
    env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    env.ECC_PLUGIN_ROOT = pluginRoot;
  }
  if (projectDir) {
    env.CLAUDE_PROJECT_DIR = projectDir;
  }
  return { pluginRoot: pluginRoot || null, projectDir: projectDir || null };
}

function readStdin(done) {
  if (process.stdin.isTTY) {
    done('');
    return;
  }
  let data = '';
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    done(data);
  };
  const timer = setTimeout(() => {
    try {
      process.stdin.destroy();
    } catch {
      // ignore
    }
    finish();
  }, STDIN_BUDGET_MS);
  timer.unref();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    data += chunk;
    if (data.length > 4 * 1024 * 1024) finish();
  });
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
}

function parsePayload(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function main() {
  const event = resolveEvent(process.argv);
  readStdin(raw => {
    try {
      const payload = parsePayload(raw);
      const projectDir = resolveProjectDir(process.env, payload, process.cwd());
      setupEnv(process.env, projectDir);
      // Phase 1: skeleton only. Phase 6 dispatches hook-ids from
      // cursor-plugin/maps/hook-map.json here (hook-flags, profiles,
      // double-load dedup by hook-id).
      void event;
    } catch {
      // hooks must not crash the host
    }
    process.exit(0);
  });
}

// Form A loads this file via require(): run unless required from a .js
// module (unit tests import the pure functions).
const requiredFromJs = process.argv.some(a => typeof a === 'string' && a.endsWith('.js') && !a.endsWith('run.js'));
if (require.main === module || !requiredFromJs) {
  main();
}

module.exports = { resolveEvent, resolveProjectDir, setupEnv, parsePayload };
