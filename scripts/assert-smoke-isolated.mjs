/**
 * P1-10 guard: make sure real-network smoke tests stay out of the default test run.
 *
 * Checks:
 *   1. vitest.config.ts excludes tests/smoke/**
 *   2. package.json exposes a separate `test:smoke` script
 *   3. a dedicated vitest.smoke.config.ts exists and only includes tests/smoke/**
 *
 * Exit code 1 on any violation, so CI fails loudly if someone re-couples them.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const problems = [];

function read(p) {
  try {
    return readFileSync(resolve(root, p), 'utf8');
  } catch {
    return null;
  }
}

const vitestConfig = read('vitest.config.ts');
const smokeConfig = read('vitest.smoke.config.ts');
const pkgRaw = read('package.json');

if (!vitestConfig) {
  problems.push('vitest.config.ts not found');
} else if (!/tests\/smoke\/\*\*/.test(vitestConfig) || !/exclude:/.test(vitestConfig)) {
  problems.push('vitest.config.ts does not exclude tests/smoke/**');
}

if (!smokeConfig) {
  problems.push('vitest.smoke.config.ts not found');
} else if (!/tests\/smoke\/\*\*/.test(smokeConfig) || !/include:/.test(smokeConfig)) {
  problems.push('vitest.smoke.config.ts does not scope include to tests/smoke/**');
}

if (!pkgRaw) {
  problems.push('package.json not found');
} else {
  const pkg = JSON.parse(pkgRaw);
  const testScript = pkg.scripts?.test ?? '';
  const smokeScript = pkg.scripts?.['test:smoke'] ?? '';
  if (!smokeScript.includes('vitest.smoke.config.ts')) {
    problems.push('package.json is missing a "test:smoke" script pointing at vitest.smoke.config.ts');
  }
  if (testScript.includes('smoke')) {
    problems.push('package.json "test" script must not include smoke tests');
  }
}

if (problems.length) {
  console.error('[smoke-isolation] FAILED:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

console.log('[smoke-isolation] OK: default test run is offline, smoke is opt-in via pnpm test:smoke');
