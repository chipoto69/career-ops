// tests/sync-batch-input.test.mjs — pipeline.md "Pending" -> batch-input.tsv (#3391).
//
// Covers the parser contract this script mirrors from reconcile-pipeline.mjs
// (localized section headers, variable-width rows, labeled segments), the
// dedupe against already-queued/processed URLs, and the batch row format.
//
// Imported directly (like rank-pipeline.test.mjs) so the pure functions are
// exercised without spawning the CLI.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nsync-batch-input — pipeline "Pending" -> batch-input.tsv');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'sync-batch-input.mjs')).href);
  const { parsePending, urlsFromTsv, planBatchRows, buildNotes, lineUrl, lineCompany, extractLabels, PENDING_RE } = mod;
  const check = (label, cond) => (cond ? pass(label) : fail(label));

  // ── section-header matching (mirrors reconcile-pipeline's localized PENDING_RE) ──
  check('English header is recognised', PENDING_RE.test('## Pending'));
  check('Spanish header is recognised', PENDING_RE.test('## Pendientes'));
  check('German header is recognised', PENDING_RE.test('## Offen'));
  check('French header is recognised', PENDING_RE.test('## En attente'));
  check('a non-pending header is not matched', !PENDING_RE.test('## Processed'));

  // ── url / company / label extraction ──
  check('bare URL parses', lineUrl('https://x.test/1') === 'https://x.test/1');
  check('url stops at the first pipe', lineUrl('https://x.test/2 | Acme | Role') === 'https://x.test/2');
  check('company is the second positional cell', lineCompany('https://x.test/3 | Acme | Role') === 'Acme');
  check('a bare row has no company', lineCompany('https://x.test/4') === '');
  const labels = extractLabels('https://x.test/5 | Acme | Role | note: curated | trust: 80 missing_apply_url');
  check('note label extracts', labels.note === 'curated');
  check('trust label extracts with flags', labels.trust === '80 missing_apply_url');
  check('unlabelled rows yield no labels', Object.keys(extractLabels('https://x.test/6 | Acme | Role')).length === 0);
  check(
    'notes are labelled segments joined by pipes',
    buildNotes({ note: 'curated', trust: '80 missing_apply_url' }) === 'note: curated | trust: 80 missing_apply_url',
  );

  // ── parsePending: variable-width rows + localized headers ──
  const es = parsePending([
    '## Pendientes',
    '- [ ] https://x.test/1',
    '- [ ] https://x.test/2 | Acme | Backend Engineer | Remote',
    '- [ ] https://x.test/3 | Beta | SA | Remote | 180000 | note: curated',
    '## Procesadas',
    '- [x] https://x.test/4 | Gamma | Done',
  ].join('\n'));
  check('three pending rows parsed under a Spanish header', es.length === 3);
  check('bare row has empty company/notes', es[0].company === '' && es[0].notes === '');
  check('4-column row keeps company', es[1].company === 'Acme');
  check('labelled segment becomes notes', es[2].notes === 'note: curated');

  const processed = parsePending([
    '## Pending',
    '- [ ] https://x.test/9 | Acme | Role',
    '',
    '- [ ] https://x.test/10 | Beta | Role | note: curated',
  ].join('\n'));
  check('blank lines are skipped', processed.length === 2);

  // ── urlsFromTsv (existing input + state) ──
  const inputTsv = [
    '# batch-input.tsv header comment',
    'https://queued.test/1\tsource\ttopic\tnotes',
    'https://queued.test/2\tpipeline\tCo\t',
    '',
  ].join('\n');
  const inputUrls = urlsFromTsv(inputTsv, 0);
  check('existing input URLs are collected', inputUrls.has('https://queued.test/1'));
  check('header comment and blanks are ignored', inputUrls.size === 2);

  const stateTsv = [
    'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries',
    '1\thttps://done.test/1\tcompleted\t2026-08-25\t2026-08-25\t1\t3.5\t\t0',
  ].join('\n');
  const stateUrls = urlsFromTsv(stateTsv, 1);
  check('batch-state URLs are collected from column 2', stateUrls.has('https://done.test/1'));

  // ── planBatchRows: dedupe + row format ──
  const pending = parsePending([
    '## Pending',
    '- [ ] https://new.test/1 | Acme | Role',
    '- [ ] https://queued.test/1 | Beta | Role',
    '- [ ] https://new.test/3 | Gamma | Role | trust: 90 suspicious_domain',
    '- [ ] https://new.test/2', // bare
  ].join('\n'));
  const existing = new Set([...inputUrls, ...stateUrls]);
  const rows = planBatchRows(pending, existing);
  check('queued and processed URLs are deduped', rows.length === 3);
  check('a fresh entry carries url/source/topic/notes tabs', rows[0].row === 'https://new.test/1\tpipeline\tAcme\t');
  check('labelled segments ride into notes', rows.some((r) => r.notes === 'trust: 90 suspicious_domain'));
  check('a bare row keeps empty company and notes', rows.some((r) => r.row === 'https://new.test/2\tpipeline\t\t'));
  check('every row uses the pipeline source', rows.every((r) => r.row.includes('\tpipeline\t')));
} catch (err) {
  fail(`sync-batch-input test suite threw: ${err?.message ?? err}`);
}
