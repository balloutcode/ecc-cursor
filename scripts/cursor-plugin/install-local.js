#!/usr/bin/env node
'use strict';

/**
 * Installs the built ecc-cursor plugin for local development:
 * copies (never symlinks) build/cursor-plugin/ecc-cursor to
 * $USERPROFILE/.cursor/plugins/local/ecc-cursor, overwriting only that
 * folder. Requires node >= 18 in PATH (Cursor runs hooks through node).
 * After install: Developer: Reload Window in Cursor.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO_ROOT, 'build', 'cursor-plugin', 'ecc-cursor');
const DEST = path.join(os.homedir(), '.cursor', 'plugins', 'local', 'ecc-cursor');

function checkNode() {
  const result = spawnSync('node', ['--version'], { encoding: 'utf8' });
  if (result.error) {
    console.error('node not found in PATH. Hooks require node >= 18 in PATH.');
    process.exit(1);
  }
  const major = parseInt(String(result.stdout).trim().replace(/^v/, '').split('.')[0], 10);
  if (!Number.isFinite(major) || major < 18) {
    console.error(`node >= 18 required, found ${String(result.stdout).trim()}`);
    process.exit(1);
  }
}

if (require.main === module) {
  checkNode();
  if (!fs.existsSync(path.join(SRC, '.cursor-plugin', 'plugin.json'))) {
    console.error('build output missing. Run: node scripts/cursor-plugin/build.js');
    process.exit(1);
  }
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  fs.cpSync(SRC, DEST, { recursive: true });

  const countFiles = dir => {
    let n = 0;
    const walk = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (e.isFile()) n += 1;
      }
    };
    walk(dir);
    return n;
  };
  console.log(`installed ecc-cursor -> ${DEST} (${countFiles(DEST)} files, copy)`);
  console.log('next: in Cursor run "Developer: Reload Window", then check Customize -> Plugins.');
}

module.exports = { DEST, SRC };
