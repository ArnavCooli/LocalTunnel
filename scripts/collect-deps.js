#!/usr/bin/env node
/**
 * Copies the transitive production dependencies of the named packages into the
 * gateway bundle.
 *
 * npm's flat node_modules means a plain `cp -R node_modules` would drag in every
 * dev dependency including Electron. This walks the actual dependency graph instead.
 */
const { cpSync, existsSync, readFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const [root, stage, ...roots] = process.argv.slice(2);
if (!root || !stage || roots.length === 0) {
  console.error('usage: collect-deps.js <repoRoot> <stageDir> <package>...');
  process.exit(1);
}

const seen = new Set();
const queue = [...roots];

while (queue.length > 0) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  seen.add(name);

  const source = join(root, 'node_modules', name);
  const manifestPath = join(source, 'package.json');
  if (!existsSync(manifestPath)) {
    console.error(`  ! ${name} is not installed; skipping`);
    continue;
  }

  const target = join(stage, 'node_modules', name);
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
    cpSync(source, target, { recursive: true });
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (!seen.has(dependency)) queue.push(dependency);
  }
}

console.log(`==> bundled ${seen.size} runtime packages`);
