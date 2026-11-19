#!/usr/bin/env node
/**
 * ecc-cursor phase-1 probe hook.
 *
 * Logs how Cursor actually invokes plugin hooks on Windows: command form,
 * argv, cwd, env vars and the stdin payload. Writes one JSON line per
 * invocation to ~/.cursor/ecc/probe.log (override home in tests via
 * ECC_PROBE_HOME).
 *
 * Never blocks, never fails: always exits 0 and writes nothing to stdout.
 *
 * Command forms under test (see cursor-plugin/maps/hook-map.json):
 *   A: node -e "require(require('path').join(process.env.CURSOR_PLUGIN_ROOT,'hooks','probe.js'))" <event>
 *   B: node ./hooks/probe.js <event>
 * Form A loads this file via require (argv = [node, <event>]); form B runs it
 * as a script (argv = [node, <path>, <event>]). The event is therefore always
 * process.argv.at(-1).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROBE_EVENTS = new Set(['sessionStart', 'preToolUse', 'stop', 'subagentStop']);
const STDIN_BUDGET_MS = 1500;

function resolveEvent(argv) {
  return (argv && argv.length ? argv[argv.length - 1] : '') || '';
}

function probeLogPath() {
  const home = process.env.ECC_PROBE_HOME || os.homedir();
  return path.join(home, '.cursor', 'ecc', 'probe.log');
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
    if (data.length > 1024 * 1024) finish();
  });
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
}

function summarizePayload(raw) {
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw);
    return {
      keys: Object.keys(payload).sort(),
      workspace_roots: Array.isArray(payload.workspace_roots) ? payload.workspace_roots : null,
      tool_name: typeof payload.tool_name === 'string' ? payload.tool_name : undefined,
      hook_event_name: typeof payload.hook_event_name === 'string' ? payload.hook_event_name : undefined,
    };
  } catch {
    return { parseError: true, length: raw.length };
  }
}

function main() {
  const event = resolveEvent(process.argv);
  readStdin(raw => {
    try {
      if (PROBE_EVENTS.has(event)) {
        const record = {
          ts: new Date().toISOString(),
          event,
          argv: process.argv,
          argvForm: process.argv.length >= 3 && String(process.argv[1]).endsWith('.js') ? 'B' : 'A',
          execPath: process.execPath,
          cwd: process.cwd(),
          env: {
            CURSOR_PLUGIN_ROOT: process.env.CURSOR_PLUGIN_ROOT ?? null,
            CURSOR_PROJECT_DIR: process.env.CURSOR_PROJECT_DIR ?? null,
            CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR ?? null,
          },
          payload: summarizePayload(raw),
          platform: process.platform,
          node: process.version,
        };
        const logPath = probeLogPath();
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, JSON.stringify(record) + '\n', 'utf8');
      }
    } catch {
      // probe must never fail the hook
    }
    process.exit(0);
  });
}

// Form A loads the file via require(): run unless we were required from a
// normal .js module (tests).
const requiredFromJs = process.argv.some(a => typeof a === 'string' && a.endsWith('.js') && !a.includes('probe'));
if (require.main === module || !requiredFromJs) {
  main();
}
