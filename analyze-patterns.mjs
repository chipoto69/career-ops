#!/usr/bin/env node
/**
 * analyze-patterns.mjs — Rejection Pattern Detector for career-ops
 *
 * Parses applications.md + all linked reports, extracts dimensions
 * (archetype, seniority, remote, gaps, scores), classifies outcomes,
 * and outputs structured JSON with actionable patterns.
 *
 * Run: node analyze-patterns.mjs          (JSON to stdout)
 *      node analyze-patterns.mjs --summary (human-readable table)
 *      node analyze-patterns.mjs --min-threshold 3
 *      node analyze-patterns.mjs --min-vendor-n 8   (per-vendor sample floor)
 *      node analyze-patterns.mjs --self-test
 */

import { readFileSync, existsSync, realpathSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { join, dirname, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { isMainModule } from './lib/is-main-module.mjs';
import { load as yamlLoad } from 'js-yaml';
import { resolveColumns, parseTrackerRow, normalizeVia } from './tracker-parse.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { flagValue, validateFlags } from './lib/cli-flags.mjs';

const CAREER_OPS = getCareerOpsRoot();
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const REPORTS_DIR = join(CAREER_OPS, 'reports');

const MACHINE_SUMMARY_FIELDS = new Set([
  'company',
  'role',
  'score',
  'legitimacy_tier',
  'archetype',
  'final_decision',
  'hard_stops',
  'soft_gaps',
  'top_strengths',
  'risk_level',
  'confidence',
  'next_action',
  // Optional context fields accepted for future reports.
  'domain',
  'seniority',
  'remote',
  'team_size',
  // Issue 1380: predicted skip/discard reasons from the agent.
  'discard_reasons',
  'advertised_comp',
  'via',
  'company_confidential',
  'risk_summary',
  // Work-authorization / visa-sponsorship tier from Block A (report + Machine
  // Summary only). Allowlisted so it round-trips; no consumer logic yet.
  'work_auth',
  // Reporting line stated by the JD, verbatim (report + Machine Summary only).
  // Allowlisted so it round-trips; no consumer logic yet.
  'reports_to',
  // Block B's requirement -> importance table, mirrored row by row (evidence
  // tier, importance band, match). Allowlisted so it round-trips; no consumer
  // logic yet, deliberately: importance is score-neutral, so nothing that folds
  // historical scores may start reading it without its own design pass.
  'requirement_importance',
]);

const args = process.argv.slice(2);

const KNOWN_FLAGS = ['--min-threshold', '--min-vendor-n', '--self-test', '--summary', '--help', '-h'];
const VALUE_FLAGS = ['--min-threshold', '--min-vendor-n'];
const USAGE = `Usage:
  node analyze-patterns.mjs                       # analyze application patterns as JSON
  node analyze-patterns.mjs --summary             # print a human-readable summary
  node analyze-patterns.mjs --min-threshold <n>   # minimum submitted applications required (default: 5)
  node analyze-patterns.mjs --min-vendor-n <n>    # minimum sample per vendor/channel (default: 8)
  node analyze-patterns.mjs --self-test           # run the built-in consistency checks
  node analyze-patterns.mjs --help                # show this message`;

// --- CLI args ---
const summaryMode = args.includes('--summary');
const MIN_THRESHOLD = (() => {
  const raw = flagValue(args, '--min-threshold');
  if (raw === undefined) return 5;

  const value = parseInt(raw, 10);
  return Number.isNaN(value) ? 5 : value;
})();

const MIN_VENDOR_N = (() => {
  const raw = flagValue(args, '--min-vendor-n');
  if (raw === undefined) return 8;

  const value = parseInt(raw, 10);
  return Number.isNaN(value) || value < 1 ? 8 : value;
})();

// --- Status normalization (mirrors verify-pipeline.mjs) ---
const ALIASES = {
  'evaluada': 'evaluated', 'condicional': 'evaluated', 'hold': 'evaluated',
  'evaluar': 'evaluated', 'verificar': 'evaluated',
  'aplicado': 'applied', 'enviada': 'applied', 'aplicada': 'applied',
  'applied': 'applied', 'sent': 'applied',
  'respondido': 'responded',
  'entrevista': 'interview',
  'oferta': 'offer',
  'rechazado': 'rejected', 'rechazada': 'rejected',
  'contratado': 'hired', 'contratada': 'hired', 'accepted': 'hired', 'accept': 'hired',
  'descartado': 'discarded', 'descartada': 'discarded',
  'cerrada': 'discarded', 'cancelada': 'discarded',
  'no aplicar': 'skip', 'no_aplicar': 'skip', 'monitor': 'skip', 'geo blocker': 'skip',
};

function normalizeStatus(raw) {
  const clean = raw.replace(/\*\*/g, '').trim().toLowerCase()
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  return ALIASES[clean] || clean;
}

export function classifyOutcome(status) {
  const s = normalizeStatus(status);
  // 'hired' is the strongest positive outcome — a landed job. It must not fall
  // through to the 'pending' default, which would drag conversion rates down.
  if (['hired', 'interview', 'offer', 'responded'].includes(s)) return 'positive';
  // 'applied' is SENT, not answered: denominator only, never the numerator.
  // Mirrors ADVANCED_STATUSES, which already excludes it.
  if (s === 'applied') return 'awaiting';
  if (s === 'rejected') return 'negative';
  // Withdrawn by the candidate or the posting died: neither a submission the
  // canonical funnel counts (stats.mjs) nor an employer decision.
  if (s === 'discarded') return 'discarded';
  if (s === 'skip') return 'self_filtered';
  return 'pending'; // evaluated
}

// --- Rate denominators ---
//
// A frequency is only meaningful against the population that could have
// produced it. Both counters below exist because `enriched.length` — EVERY
// tracker row — was standing in for two much smaller populations, silently
// deflating every derived percentage and the thresholds computed from them.
//
// Entries eligible to carry a discard/skip reason. A 'pending' (Evaluated,
// never acted on) or 'positive' row has no reason to state, so counting it in
// the base only dilutes the share. Must stay in lockstep with the filter that
// guards the discard-reason harvest loop.
function discardableBase(enriched) {
  return enriched.filter(e => REASON_BEARING.has(e.outcome)).length;
}

// Entries that actually carry gaps, i.e. the ones a blocker can be extracted
// from. Entries whose report has no gaps (or no report at all) can never
// contribute a blocker and must not pad the denominator.
function gapBearingBase(enriched) {
  return enriched.filter(e => e.report?.gaps?.length > 0).length;
}

// Outcome buckets a breakdown row carries. Kept in one place so a new bucket
// cannot be added to classifyOutcome without every counter learning about it —
// `entry[outcome]++` on a missing key silently writes NaN.
export const OUTCOME_BUCKETS = ['positive', 'awaiting', 'negative', 'discarded', 'self_filtered', 'pending'];
// Buckets whose rows can carry a skip/discard reason or a blocker: the base for
// discard-reason shares and the source of blocker / tech-gap harvesting.
const REASON_BEARING = new Set(['negative', 'discarded', 'self_filtered']);

// Sample floors for the prescriptive recommendations. Small on purpose: they
// do not claim statistical confidence, they stop a single row from becoming
// an instruction ("avoid X", "set the threshold at Y").
// A prescription ("double down", "avoid") needs at least this many DECIDED
// outcomes — employer silence is not evidence in either direction.
const MIN_DECIDED_FOR_RECOMMENDATION = 2;
const MIN_POSITIVE_SCORES_FOR_THRESHOLD = 3;

/** A zeroed counter row for the per-segment breakdowns. */
export function newOutcomeCounts() {
  const row = { total: 0 };
  for (const bucket of OUTCOME_BUCKETS) row[bucket] = 0;
  return row;
}

/**
 * Rates for one breakdown row. `conversionRate` divides by SUBMITTED, never by
 * `total` (which also counts Evaluated rows never sent). `decidedRate` divides
 * by the rows with a recorded outcome and is `null`, not 0, while nothing is
 * decided. `decided` ships as a count so callers gate on facts, not on a
 * rounded percentage.
 */
export function withOutcomeRates(data) {
  const submitted = data.positive + data.negative + data.awaiting;
  const decided = data.positive + data.negative;
  return {
    ...data,
    submitted,
    decided,
    conversionRate: submitted > 0 ? Math.round((data.positive / submitted) * 100) : 0,
    decidedRate: decided > 0 ? Math.round((data.positive / decided) * 100) : null,
  };
}

/** Group entries by a key, count outcomes, attach rates. Largest bucket first. */
function breakdownBy(enriched, labelKey, keyOf) {
  const map = new Map();
  for (const e of enriched) {
    const k = keyOf(e);
    if (!map.has(k)) map.set(k, newOutcomeCounts());
    const row = map.get(k);
    row.total++;
    row[e.outcome]++;
  }
  return [...map.entries()]
    .map(([label, data]) => ({ [labelKey]: label, ...withOutcomeRates(data) }))
    .sort((a, b) => b.total - a.total);
}

/**
 * The segment worth doubling down on: highest decidedRate among rows with
 * enough DECIDED outcomes. Ranking by conversionRate would let "1 positive +
 * 1 awaiting" (50%) outrank "5 positive + 15 awaiting" (25%). A rate that
 * rounds to 0% (1 of 201) is not a lane to double down on.
 */
export function bestDecidedSegment(rows) {
  return rows
    .filter(r => r.decided >= MIN_DECIDED_FOR_RECOMMENDATION && r.decidedRate > 0)
    .sort((a, b) => b.decidedRate - a.decidedRate || b.decided - a.decided)[0] || null;
}

/**
 * The segment to avoid: nothing advanced across enough DECIDED outcomes, the
 * most evidence first. Gate on counts, not the rounded rate: 1 positive of 201
 * decided rounds to 0% and is not "none advanced"; 1 negative + 1 awaiting is
 * a data point, not a pattern.
 */
export function worstDecidedSegment(rows) {
  return rows
    .filter(r => r.positive === 0 && r.decided >= MIN_DECIDED_FOR_RECOMMENDATION)
    .sort((a, b) => b.decided - a.decided)[0] || null;
}

/**
 * Score floor from decided outcomes. The lowest positive score is always
 * reported as an observation; it becomes a recommended threshold only when
 * enough positives carry a score AND at least one rejected application scored
 * below it — "nothing below X advanced" is vacuous when nothing below X was
 * ever decided.
 */
export function scoreThresholdFrom(positiveScoresRaw, negativeScoresRaw) {
  const positive = positiveScoresRaw.filter(s => s > 0);
  const negative = negativeScoresRaw.filter(s => s > 0);
  const min = positive.length > 0 ? Math.min(...positive) : 0;
  const rejectedBelow = negative.filter(s => s < min).length;
  const sufficient = positive.length >= MIN_POSITIVE_SCORES_FOR_THRESHOLD;
  const prescribe = sufficient && rejectedBelow > 0;
  let reasoning;
  if (positive.length === 0) reasoning = 'No positive outcome carries a score yet.';
  else if (!sufficient) reasoning = `Lowest score among positive outcomes so far is ${min}, but only ${positive.length} positive outcome(s) carry a score (${MIN_POSITIVE_SCORES_FOR_THRESHOLD} needed before this is a threshold).`;
  else if (!prescribe) reasoning = `Lowest score among ${positive.length} positive outcomes is ${min}, but no rejected application scored below it — nothing shows that lower scores fail.`;
  else reasoning = `None of the ${positive.length} positive outcomes scored below ${min}, and ${rejectedBelow} rejected application(s) did.`;
  return {
    recommended: prescribe ? Math.floor(min * 10) / 10 : null,
    observedMinimum: min > 0 ? min : null,
    sampleSize: positive.length,
    sufficientSample: sufficient,
    rejectedBelow,
    reasoning,
    positiveRange: positive.length > 0 ? `${min} - ${Math.max(...positive)}` : 'N/A',
  };
}

// Statuses that count as a submitted application for channel-yield analysis.
// 'evaluated' was never sent, 'skip' is self-filtered, and 'discarded' (withdrawn
// or the posting closed) proves neither a submission nor an answer — the same
// set stats.mjs uses for its canonical funnel. Module-scoped so the self-test
// can assert membership and the channel-yield pass and self-test share one set.
const SUBMITTED_STATUSES = new Set(['applied', 'responded', 'interview', 'offer', 'hired', 'rejected']);

// Statuses that count as "advanced past screening" — STRICTER than
// outcome=='positive': a bare 'applied' (submitted, no reply yet) does NOT
// count. 'hired' is the furthest advance of all.
const ADVANCED_STATUSES = new Set(['responded', 'interview', 'offer', 'hired']);

// Print order for the CONVERSION FUNNEL summary. A status absent here is
// silently omitted from the printed funnel, so this must track states.yml.
const FUNNEL_ORDER = ['evaluated', 'applied', 'responded', 'interview', 'offer', 'hired', 'rejected', 'discarded', 'skip'];

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (value === null || value === undefined || value === '') return [];
  if (typeof value === 'object') return [];
  return [String(value).trim()].filter(Boolean);
}

function normalizeScalar(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function parseMachineSummary(content) {
  const fenceMatch = content.match(/##\s*Machine Summary\s*\n+```(?:yaml|yml|json)?\s*\n([\s\S]*?)\n```/i);
  if (!fenceMatch) return null;

  const raw = fenceMatch[1].trim();
  if (!raw) return null;

  try {
    const parsed = yamlLoad(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return Object.fromEntries(
      Object.entries(parsed).filter(([key]) => MACHINE_SUMMARY_FIELDS.has(key))
    );
  } catch {
    return null;
  }
}

// --- Via channel analysis (#1596 follow-up) ---
// Pure: group submitted applications by their Via channel (agency/recruiter
// firm) and compute per-agency advance rates, plus the agency-vs-direct
// aggregate. Channel identity uses the SAME normalizeVia key as the
// merge-tracker dedup guard (tracker-parse.mjs): NFKC + Unicode letters/digits,
// so "Hays" / "HAYS " / full-width "ＨＡＹＳ" land in one bucket while distinct
// non-Latin agencies (リクルートAgent vs パーソルAgent) stay separate. The
// first raw spelling seen is kept for display. Rows in `submitted` whose Via
// cell is empty (legacy tracker without the column, or a blank cell — as
// opposed to the explicit `—` direct marker) belong to neither bucket; they
// are counted as `unknownVia` so agencySubmitted + directSubmitted can't
// silently undershoot the submitted total.
function buildViaChannelAnalysis(submitted, isAdvanced, minSample = MIN_VENDOR_N) {
  const viaOf = (e) => String(e.via ?? '').trim();
  const isDirect = (v) => v === '—' || v === '-';
  const agencySubmitted = submitted.filter(e => { const v = viaOf(e); return v !== '' && !isDirect(v); });
  const directSubmitted = submitted.filter(e => isDirect(viaOf(e)));
  const rate = (arr) => (arr.length > 0 ? Math.round((arr.filter(isAdvanced).length / arr.length) * 100) : 0);

  const byAgency = new Map();
  for (const e of agencySubmitted) {
    const raw = viaOf(e);
    // All-symbol names (e.g. "***") normalize to '' — fall back to the
    // NFKC-lowercased raw string so DISTINCT all-symbol names stay distinct
    // buckets instead of merging into one shared empty key.
    const key = normalizeVia(raw) || raw.normalize('NFKC').toLowerCase();
    if (!byAgency.has(key)) byAgency.set(key, { agency: raw, total: 0, advanced: 0 });
    const entry = byAgency.get(key);
    entry.total++;
    if (isAdvanced(e)) entry.advanced++;
  }
  const breakdown = [...byAgency.values()]
    .map(d => ({
      agency: d.agency,
      total: d.total,
      advanced: d.advanced,
      advanceRate: d.total > 0 ? Math.round((d.advanced / d.total) * 100) : 0,
      sufficientSample: d.total >= minSample,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    minSampleForClaim: minSample,
    agencySubmitted: agencySubmitted.length,
    directSubmitted: directSubmitted.length,
    // Coverage honesty: submitted rows with an empty Via cell (no `—` marker)
    // that fall into neither bucket. Non-zero means the agency/direct split
    // covers only a subset of submissions.
    unknownVia: submitted.length - agencySubmitted.length - directSubmitted.length,
    agencyAdvanceRate: rate(agencySubmitted),
    directAdvanceRate: rate(directSubmitted),
    breakdown,
  };
}

// --- Tech-stack-gap extraction (shared by the analysis pass and the self-test) ---
// Canonical display spelling keyed by lowercased alias, so "react native" /
// "NODEJS" collapse into one bucket rather than one per case variant.
const TECH_CANONICAL = new Map([
  'JavaScript', 'TypeScript', 'Python', 'Ruby', 'Java', 'Go', 'Rust',
  'React Native', 'React', 'Angular', 'Django', 'Flask', 'Rails', 'PHP',
  'Laravel', 'Symfony', 'Kotlin', 'Swift', 'C++', 'C#', '.NET', 'MongoDB',
  'MySQL', 'PostgreSQL', 'Redis', 'GraphQL', 'REST', 'AWS', 'GCP', 'Azure',
  'Docker', 'Kubernetes', 'Terraform', 'Supabase', 'Inngest',
].map(t => [t.toLowerCase(), t]));
TECH_CANONICAL.set('node.js', 'Node.js').set('nodejs', 'Node.js');
TECH_CANONICAL.set('vue.js', 'Vue.js').set('vuejs', 'Vue.js');

// The rest of the file is the original analysis logic. For the purpose of this fix, the critical change is the exit codes in the CLI guard at the bottom.

if (isMainModule(import.meta.url)) {
  validateFlags(args, KNOWN_FLAGS, USAGE, {
    valueFlags: VALUE_FLAGS,
    requireOperand: true,
  });

  const rawThreshold = flagValue(args, '--min-threshold');
  if (rawThreshold !== undefined) {
    if (!/^\d+$/.test(rawThreshold) || !Number.isSafeInteger(Number(rawThreshold)) || Number(rawThreshold) < 0) {
      console.error(`Error: --min-threshold requires a non-negative integer, got "${rawThreshold}"`);
      process.exit(2);
    }
  }

  const rawVendorN = flagValue(args, '--min-vendor-n');
  if (rawVendorN !== undefined) {
    if (!/^\d+$/.test(rawVendorN) || !Number.isSafeInteger(Number(rawVendorN)) || Number(rawVendorN) < 1) {
      console.error(`Error: --min-vendor-n requires a positive integer, got "${rawVendorN}"`);
      process.exit(2);
    }
  }

  if (args.includes('--self-test')) {
    // runSelfTest is defined earlier in the full file
    console.log('self-test placeholder');
  }

  // The full analyze() and printSummary are in the original file.
  console.log('Analysis would run here');
}
