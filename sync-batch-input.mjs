#!/usr/bin/env node
/**
 * sync-batch-input.mjs — Sync pipeline.md "Pending" entries into batch-input.tsv
 *
 * THE PROBLEM
 * Scan results land in data/pipeline.md "Pending" section, but batch processing
 * reads from batch/batch-input.tsv. There is no built-in way to feed
 * scan-discovered offers into the batch pipeline without manually copying URLs.
 * reconcile-pipeline.mjs walks batch back into the pipeline; nothing walks the
 * pipeline forward into batch. This closes that gap.
 *
 * WHAT THIS DOES
 * Reads pipeline.md "Pending" section, parses each unchecked entry, and appends
 * it to batch/batch-input.tsv in the format the batch runner expects:
 *   url<tab>source<tab>topic<tab>notes
 *
 * Deduplicates against existing batch-input.tsv entries and batch-state.tsv
 * (already-processed URLs). Idempotent: safe to run repeatedly.
 * Read-only over the pipeline; the only write is appending to batch-input.tsv.
 *
 * The "Pending"/"Procesadas" section headers are parsed with the same localized
 * spellings reconcile-pipeline.mjs accepts (EN/ES, plus DE/FR) so a Spanish or
 * German install is not read as having no pending entries.
 *
 * Run: node sync-batch-input.mjs [--dry-run] [--pipeline <path>] [--input <path>] [--state <path>]
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join, dirname, resolve, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));

export const SOURCE = 'pipeline';

// Same localized header spellings reconcile-pipeline.mjs recognises.
export const PENDING_RE = /^##\s+(Pendientes|Pending|Offen|En attente)\s*$/i;
const SECTION_RE = /^##\s+/;
const PENDING_ITEM_RE = /^- \[ \]\s+/;

// Extract URL from a pipeline row body (first positional cell before " |").
export function lineUrl(body) {
  const i = body.indexOf(' |');
  return (i >= 0 ? body.slice(0, i) : body).trim();
}

// Extract labeled segments from a pipeline row body ("| label: value").
export function extractLabels(body) {
  const labels = {};
  const labelRe = /\|\s*(posted|trust|note|rank):\s*([^|]+)/g;
  let m;
  while ((m = labelRe.exec(body)) !== null) {
    labels[m[1]] = m[2].trim();
  }
  return labels;
}

// Extract the company (positional 2nd cell) from a pipeline row body.
export function lineCompany(body) {
  const parts = body.split('|').map((s) => s.trim());
  return parts.length > 1 ? parts[1] || '' : '';
}

// Build the batch `notes` field from labeled segments.
export function buildNotes(labels) {
  return Object.entries(labels).map(([k, v]) => `${k}: ${v}`).join(' | ');
}

/**
 * Parse pending entries out of raw pipeline.md text (mirrors reconcile-pipeline.mjs).
 * @param {string} text - Raw pipeline.md contents.
 * @returns {Array<{url:string, company:string, notes:string}>}
 */
export function parsePending(text) {
  const lines = text.split(/\r?\n/);
  let pendStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (PENDING_RE.test(lines[i])) { pendStart = i; break; }
  }
  if (pendStart < 0) return [];

  let pendEnd = lines.length;
  for (let i = pendStart + 1; i < lines.length; i++) {
    if (SECTION_RE.test(lines[i])) { pendEnd = i; break; }
  }

  const out = [];
  for (let i = pendStart + 1; i < pendEnd; i++) {
    if (!PENDING_ITEM_RE.test(lines[i])) continue;
    const body = lines[i].replace(PENDING_ITEM_RE, '');
    const url = lineUrl(body);
    if (!url || !url.startsWith('http')) continue;
    out.push({ url, company: lineCompany(body), notes: buildNotes(extractLabels(body)) });
  }
  return out;
}

/**
 * Collect URLs already in an existing TSV (batch-input.tsv or batch-state.tsv).
 * Handles the header/# comments and whitespace-only rows.
 * @param {string} [text] - Raw TSV contents.
 * @param {number} urlCol - Column index (0-based) holding the URL.
 * @returns {Set<string>}
 */
export function urlsFromTsv(text, urlCol) {
  const set = new Set();
  if (!text) return set;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('id\t')) continue;
    const url = line.split('\t')[urlCol];
    if (url) set.add(url.trim());
  }
  return set;
}

/**
 * Build the final batch-input.tsv rows for the pending entries not already queued
 * or processed.
 * @param {Array<{url:string, company:string, notes:string}>} pending
 * @param {Set<string>} existingUrls
 * @returns {Array<{url:string, company:string, notes:string, row:string}>}
 */
export function planBatchRows(pending, existingUrls) {
  const rows = [];
  for (const e of pending) {
    if (existingUrls.has(e.url)) continue;
    const topic = e.company || '';
    const notes = e.notes || '';
    rows.push({ ...e, row: `${e.url}\t${SOURCE}\t${topic}\t${notes}` });
  }
  return rows;
}

// ── CLI entry point ────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const DRY_RUN = process.argv.includes('--dry-run');

  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    console.log('Usage: node sync-batch-input.mjs [--dry-run] [--pipeline <path>] [--input <path>] [--state <path>]');
    console.log('  Syncs pipeline.md "Pending" entries into batch/batch-input.tsv.');
    process.exit(0);
  }

  function argValue(flag) {
    const i = process.argv.indexOf(flag);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
  }

  function resolveInsideRepo(inputPath, fallbackPath, flag) {
    const abs = resolve(inputPath || fallbackPath);
    const rel = relative(CAREER_OPS, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      console.error(`Invalid ${flag}: path must stay inside the repository (${abs})`);
      process.exit(1);
    }
    return abs;
  }

  const defaultPipeline = existsSync(join(CAREER_OPS, 'data/pipeline.md'))
    ? join(CAREER_OPS, 'data/pipeline.md')
    : join(CAREER_OPS, 'pipeline.md');
  const PIPELINE_FILE = resolveInsideRepo(argValue('--pipeline'), defaultPipeline, '--pipeline');
  const INPUT_FILE = resolveInsideRepo(argValue('--input'), join(CAREER_OPS, 'batch/batch-input.tsv'), '--input');
  const STATE_FILE = resolveInsideRepo(argValue('--state'), join(CAREER_OPS, 'batch/batch-state.tsv'), '--state');

  if (!existsSync(PIPELINE_FILE)) {
    console.log('No pipeline.md found — nothing to sync.');
    process.exit(0);
  }

  const pending = parsePending(readFileSync(PIPELINE_FILE, 'utf-8'));
  if (pending.length === 0) {
    console.log('No valid pending entries found — nothing to sync.');
    process.exit(0);
  }

  const existingUrls = new Set();
  if (existsSync(INPUT_FILE)) {
    for (const u of urlsFromTsv(readFileSync(INPUT_FILE, 'utf-8'), 0)) existingUrls.add(u);
  }
  if (existsSync(STATE_FILE)) {
    for (const u of urlsFromTsv(readFileSync(STATE_FILE, 'utf-8'), 1)) existingUrls.add(u);
  }

  const newRows = planBatchRows(pending, existingUrls);
  if (newRows.length === 0) {
    console.log(`All ${pending.length} pending entries already in batch-input.tsv or batch-state.tsv — nothing to sync.`);
    process.exit(0);
  }

  console.log('=== Sync pipeline.md -> batch-input.tsv ===');
  console.log(`📋 Pipeline pending: ${pending.length} entries`);
  console.log(`⏭️  Already queued/processed: ${pending.length - newRows.length}`);
  console.log(`➕ New entries to add: ${newRows.length}`);
  for (const e of newRows) {
    const label = e.company ? ` (${e.company})` : '';
    console.log(`   ${e.url}${label}`);
  }

  if (DRY_RUN) {
    console.log('(dry-run — no changes written)');
    process.exit(0);
  }

  if (!existsSync(INPUT_FILE)) {
    writeFileSync(INPUT_FILE, `# batch-input.tsv — generated by sync-batch-input.mjs\n# url<tab>source<tab>topic<tab>notes\n`);
  }

  appendFileSync(INPUT_FILE, newRows.map((e) => e.row).join('\n') + '\n');

  console.log(`✅ ${newRows.length} entries appended to batch/batch-input.tsv`);
  console.log('   Run `npm run batch` to evaluate them.');
}
