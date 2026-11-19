#!/usr/bin/env node
'use strict';

/**
 * Generates hooks/hooks.json of the ecc-cursor plugin from
 * cursor-plugin/maps/hook-map.json.
 *
 * Phase 1: probe entries only - 4 events x 2 command forms (A: cwd/shell
 * independent `node -e require(...)`; B: `node ./hooks/probe.js`). Phase 6
 * adds the full behavioral map (hook-id -> Cursor event -> dispatcher run.js).
 *
 * Idempotent: output depends only on hook-map.json. `--check` regenerates in
 * memory and fails (exit 1) if the built file differs; used in CI.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_MAP_PATH = path.join(REPO_ROOT, 'cursor-plugin', 'maps', 'hook-map.json');
const OUT_PATH = path.join(REPO_ROOT, 'build', 'cursor-plugin', 'ecc-cursor', 'hooks', 'hooks.json');

function loadHookMap(mapPath = HOOK_MAP_PATH) {
  return JSON.parse(fs.readFileSync(mapPath, 'utf8'));
}

function renderCommand(template, entry, event) {
  return template.split('{entry}').join(entry).split('{event}').join(event);
}

function generateHooksJson(hookMap) {
  const hooks = {};
  const addEntry = (event, entry) => {
    if (!hooks[event]) hooks[event] = [];
    hooks[event].push(entry);
  };

  for (const probe of hookMap.probes || []) {
    for (const formName of ['A', 'B']) {
      const form = hookMap.commandForms[formName];
      const entry = {
        command: renderCommand(form.template, probe.entry, probe.event),
        event: probe.event,
        description: `ECC probe ${probe.id} (form ${formName})`,
      };
      if (probe.matcher) entry.matcher = probe.matcher;
      addEntry(probe.event, entry);
    }
  }

  // Phase 6: behavioral entries dispatch through run.js (command form A).
  for (const item of hookMap.entries || []) {
    const entry = {
      command: renderCommand(hookMap.commandForms.A.template, 'run.js', item.event),
      event: item.event,
      description: item.description || item.id,
    };
    if (item.matcher) entry.matcher = item.matcher;
    addEntry(item.event, entry);
  }

  return { version: 1, hooks };
}

function serialize(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function writeHooksJson(outPath = OUT_PATH) {
  const doc = generateHooksJson(loadHookMap());
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, serialize(doc), 'utf8');
  return doc;
}

function checkHooksJson(outPath = OUT_PATH) {
  const expected = serialize(generateHooksJson(loadHookMap()));
  if (!fs.existsSync(outPath)) {
    return { ok: false, reason: `missing ${path.relative(REPO_ROOT, outPath)} (run build first)` };
  }
  const actual = fs.readFileSync(outPath, 'utf8');
  if (actual !== expected) {
    return { ok: false, reason: `${path.relative(REPO_ROOT, outPath)} differs from cursor-plugin/maps/hook-map.json (re-run build)` };
  }
  return { ok: true };
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  if (check) {
    const result = checkHooksJson();
    if (!result.ok) {
      console.error(`generate-hooks --check FAILED: ${result.reason}`);
      process.exit(1);
    }
    console.log('generate-hooks --check OK (hooks.json matches hook-map.json)');
  } else {
    const doc = writeHooksJson();
    const events = Object.keys(doc.hooks).sort();
    const total = events.reduce((n, e) => n + doc.hooks[e].length, 0);
    console.log(`hooks.json written: ${events.length} events, ${total} entries -> ${path.relative(REPO_ROOT, OUT_PATH)}`);
  }
}

module.exports = { generateHooksJson, loadHookMap, writeHooksJson, checkHooksJson, serialize, OUT_PATH, HOOK_MAP_PATH };
