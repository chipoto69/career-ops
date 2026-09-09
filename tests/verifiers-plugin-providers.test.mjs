// tests/verifiers-plugin-providers.test.mjs — the scanner and both health
// checkers must resolve providers through the SAME path (#4026).
//
// scan.mjs folds enabled provider plugins into its map with
// mergeProviderPlugins(). verify-pipeline.mjs and verify-portals.mjs did not,
// so a supported `provider: <plugin-id>` portals entry was reported as an
// "unknown provider" that "never scans" — while the scanner scanned it. The
// divergence is the bug and it can reappear the moment a caller drifts, so it
// is pinned structurally (three callers must agree) AND behaviorally (an
// enabled stub plugin resolves in verify-pipeline's own load path).
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  cpSync,
  symlinkSync,
  readdirSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pass, fail, NODE } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

console.log('\nverifiers resolve provider plugins like the scanner (#4026)');

function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function prepareFixtureCodeRoot(tmp) {
  const codeRoot = join(tmp, 'code-root');
  mkdirSync(codeRoot, { recursive: true });
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && /\.(mjs|cjs|json)$/.test(entry.name)) {
      cpSync(join(ROOT, entry.name), join(codeRoot, entry.name));
    }
  }
  for (const dir of ['providers', 'plugins', 'templates', 'lib']) {
    cpSync(join(ROOT, dir), join(codeRoot, dir), { recursive: true });
  }
  if (existsSync(join(ROOT, 'node_modules'))) {
    symlinkSync(join(ROOT, 'node_modules'), join(codeRoot, 'node_modules'), 'dir');
  }
  return codeRoot;
}

// ── 1. Structural: all three provider-map builders call mergeProviderPlugins ──
{
  const callers = ['scan.mjs', 'verify-pipeline.mjs', 'verify-portals.mjs'];
  const missing = callers.filter((f) => !/mergeProviderPlugins\s*\(/.test(stripJsComments(readFileSync(join(ROOT, f), 'utf8'))));
  if (missing.length === 0) {
    pass('scan.mjs, verify-pipeline.mjs and verify-portals.mjs all execute mergeProviderPlugins()');
  } else {
    fail(`these provider-map builders skip mergeProviderPlugins() and will disagree with the scanner: ${missing.join(', ')}`);
  }
}

// ── 2. Behavioral: run the real verify-pipeline.mjs against a portals entry
//    using the bundled `apify` plugin, enabled. Before the fix it printed
//    "unknown provider: apify" and exited 1; after, apify resolves (to an
//    actionable "missing env APIFY_TOKEN" stub here) and the false error is
//    gone. The fixture runs from an isolated code root so this test never reads,
//    overwrites, or deletes a developer's real config/plugins.yml. ──
{
  const tmp = mkdtempSync(join(ROOT, '.tmp-co-4026-'));
  try {
    const codeRoot = prepareFixtureCodeRoot(tmp);
    mkdirSync(join(codeRoot, 'config'), { recursive: true });
    writeFileSync(join(codeRoot, 'config', 'plugins.yml'), 'plugins:\n  apify: { enabled: true }\n');
    const portals = join(tmp, 'portals.yml');
    writeFileSync(portals,
      'tracked_companies:\n  - name: "apify 4026"\n    provider: apify\n    actor: x/y\n    enabled: true\n');

    let pipelineOut = '';
    let pipelineExit = 0;
    try {
      pipelineOut = execFileSync(NODE, [join(codeRoot, 'verify-pipeline.mjs')], {
        cwd: codeRoot, encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CAREER_OPS_PORTALS: portals, APIFY_TOKEN: '' },
      });
    } catch (e) {
      pipelineOut = `${e.stdout || ''}${e.stderr || ''}`;
      pipelineExit = e.status ?? 1;
    }

    if (/unknown provider:\s*apify/i.test(pipelineOut)) {
      fail(`verify-pipeline.mjs still reports the enabled apify plugin as an unknown provider (exit ${pipelineExit})`);
    } else {
      pass('verify-pipeline.mjs resolves an enabled `apify` plugin provider instead of "unknown provider"');
    }

    let portalsOut = '';
    let portalsExit = 0;
    try {
      portalsOut = execFileSync(NODE, [join(codeRoot, 'verify-portals.mjs'), '--file', portals], {
        cwd: codeRoot, encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, APIFY_TOKEN: '' },
      });
    } catch (e) {
      portalsOut = `${e.stdout || ''}${e.stderr || ''}`;
      portalsExit = e.status ?? 1;
    }

    if (/unknown provider:\s*apify/i.test(portalsOut)) {
      fail(`verify-portals.mjs still reports the enabled apify plugin as an unknown provider (exit ${portalsExit})`);
    } else if (/missing env APIFY_TOKEN/i.test(portalsOut)) {
      pass('verify-portals.mjs resolves `apify` to the actionable missing-env plugin stub');
    } else {
      fail(`verify-portals.mjs did not prove apify reached the missing-env plugin path (exit ${portalsExit})`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
