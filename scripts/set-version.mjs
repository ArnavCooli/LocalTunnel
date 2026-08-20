#!/usr/bin/env node
/**
 * Write a release tag into the package versions the build reads.
 *
 * The desktop app reports `app.getVersion()` — which is whatever
 * packages/desktop/package.json said when it was packaged — and the update check
 * compares that number against the newest release tag. If the two are maintained
 * by hand they drift, and a shipped build sits there insisting it is 1.0.0 while
 * 1.2 is on the release page. So the release workflow stamps the tag it is
 * publishing under, and the two can only agree.
 *
 * Tags are written the short way (`1.2`); npm and electron-builder both want
 * three components, so a missing minor or patch is filled in with zero. That is
 * the same reading the update check applies to the tag it fetches.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** The files whose version is what the app and its installers report. */
const TARGETS = ['package.json', 'packages/desktop/package.json'];

export function normalizeVersion(tag) {
  const match = /^v?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?$/.exec(String(tag).trim());
  if (!match) return null;
  return `${Number(match[1])}.${Number(match[2] ?? 0)}.${Number(match[3] ?? 0)}`;
}

const version = normalizeVersion(process.argv[2] ?? '');
if (!version) {
  console.error(
    `set-version: "${process.argv[2] ?? ''}" is not a version tag (expected something like 1.2 or v1.2.3).`,
  );
  process.exit(1);
}

for (const target of TARGETS) {
  const path = join(root, target);
  const source = readFileSync(path, 'utf8');
  // Rewrite the top-level "version" field in place rather than reserializing:
  // the file keeps its formatting and key order, so the diff is one line.
  const updated = source.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`);
  if (updated === source && !source.includes(`"version": "${version}"`)) {
    console.error(`set-version: no version field found in ${target}.`);
    process.exit(1);
  }
  writeFileSync(path, updated);
  console.log(`${target} -> ${version}`);
}
