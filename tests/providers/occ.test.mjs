// tests/providers/occ.test.mjs — OCC Mundial (occ.com.mx) provider.
// Offline only: every assertion runs against fixtures of card/result markup,
// so CI never depends on occ.com.mx being reachable.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — occ');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/occ.mjs')).href);
  const occ = mod.default;
  const { buildSearchUrl, isEmptySearchPage, parseCards } = mod;

  if (occ.id === 'occ') pass('occ.id is "occ"');
  else fail(`occ.id is ${JSON.stringify(occ.id)}`);

  if (typeof occ.fetch === 'function') pass('occ.fetch is a function');
  else fail('occ.fetch is not a function');

  // ── URL shape ────────────────────────────────────────────────────────────
  // Page 1 carries no suffix.
  if (buildSearchUrl('automatizacion', null, 1) === 'https://www.occ.com.mx/empleos/de-automatizacion/') {
    pass('buildSearchUrl() page 1 has no pagination suffix');
  } else {
    fail(`page 1 = ${buildSearchUrl('automatizacion', null, 1)}`);
  }

  // Pagination is a SLUG suffix. ?page=N silently returns page 1 on the live
  // site, so this assertion guards the one shape that actually advances.
  if (buildSearchUrl('automatizacion', null, 3) === 'https://www.occ.com.mx/empleos/de-automatizacion-pagina-3/') {
    pass('buildSearchUrl() paginates via the -pagina-N slug, not a query param');
  } else {
    fail(`page 3 = ${buildSearchUrl('automatizacion', null, 3)}`);
  }

  // Accents fold and the state becomes an en-{slug} path segment.
  if (buildSearchUrl('robótica', 'Nuevo León', 2) === 'https://www.occ.com.mx/empleos/de-robotica-pagina-2/en-nuevo-leon/') {
    pass('buildSearchUrl() folds accents and appends the state segment');
  } else {
    fail(`accented+state = ${buildSearchUrl('robótica', 'Nuevo León', 2)}`);
  }

  // Every generated URL must stay on the occ.com.mx origin.
  const origins = [
    buildSearchUrl('../../evil', null, 1),
    buildSearchUrl('automatizacion', 'https://evil.example', 1),
  ].map(u => new URL(u).origin);
  if (origins.every(o => o === 'https://www.occ.com.mx')) {
    pass('buildSearchUrl() cannot be steered off the occ.com.mx origin');
  } else {
    fail(`origins = ${JSON.stringify(origins)}`);
  }

  // ── Card parsing ─────────────────────────────────────────────────────────
  const FIXTURE = `
    <div class="card-job-offer is-highlighted" data-id='21319670' id="jobcard-21319670">
      <h2 class="text-grey-900">INGENIERO DE AUTOMATIZACI&#xD3;N</h2>
      <span class="mr-2 text-grey-900 font-base font-light">$ 40,000 - $ 50,000 Mensual</span>
      <div class="h-[21px] flex items-center gap-1">
        <span class="text-grey-900 no-underline"> Tecnoap </span>
      </div>
      <div class="no-alter-loc-text mt-1">
        <span class="text-grey-900"></span><p class="text-grey-900">San Nicol&#xE1;s de los Garza, Nuevo Le&#xF3;n</p>
      </div>
    </div>
    <div class="card-job-offer" data-id='21321698' id="jobcard-21321698">
      <h2>T&#xE9;cnico de automatizaci&#xF3;n</h2>
      <div class="h-[21px] flex items-center gap-1">
        <span class="text-grey-900"> Empresa confidencial </span>
      </div>
      <div class="no-alter-loc-text mt-1"><span></span><p>Apodaca, Nuevo Le&#xF3;n</p></div>
    </div>
    <div class="card-job-offer" data-id='21330000' id="jobcard-21330000">
      <h2>Ingeniero de control</h2>
      <div class="h-[21px] flex items-center gap-1"></div>
      <div class="no-alter-loc-text mt-1"><span></span><p>Querétaro</p></div>
    </div>
    <div class="card-job-offer" id="jobcard-broken"><h2>Sin data-id</h2></div>
    <div class="card-job-offer" data-id='999'><h2>   </h2></div>
  `;
  const cards = parseCards(FIXTURE);

  if (cards.length === 3) pass('parseCards() drops cards missing data-id or a non-empty title');
  else fail(`parseCards() returned ${cards.length} cards, expected 3`);

  const [a, b, c] = cards;

  if (a?.title === 'INGENIERO DE AUTOMATIZACIÓN') pass('parseCards() decodes HTML entities in the title');
  else fail(`title = ${JSON.stringify(a?.title)}`);

  if (a?.url === 'https://www.occ.com.mx/empleo/oferta/21319670/') pass('parseCards() builds the posting URL from data-id');
  else fail(`url = ${JSON.stringify(a?.url)}`);

  if (a?.company === 'Tecnoap') pass('parseCards() extracts the company name');
  else fail(`company = ${JSON.stringify(a?.company)}`);

  if (a?.location === 'San Nicolás de los Garza, Nuevo León') pass('parseCards() extracts and decodes the location');
  else fail(`location = ${JSON.stringify(a?.location)}`);

  // "Empresa confidencial" is OCC's own placeholder, not an employer name.
  // It must become the locale-invariant "?" marker (#1596) so the Spanish
  // string never reaches the tracker or a report.
  if (b?.company === '?') pass('parseCards() normalizes "Empresa confidencial" to the "?" marker');
  else fail(`confidential company = ${JSON.stringify(b?.company)}`);

  if (c?.company === '') pass('parseCards() keeps a missing company empty for fetch() to mark unknown');
  else fail(`missing company parse = ${JSON.stringify(c?.company)}`);

  if (parseCards('').length === 0 && parseCards('<html></html>').length === 0) {
    pass('parseCards() returns [] for empty and card-less HTML');
  } else {
    fail('parseCards() did not return [] for empty input');
  }

  if (isEmptySearchPage('<main>No encontramos empleos para esta búsqueda</main>')) {
    pass('isEmptySearchPage() recognizes OCC empty-result copy');
  } else {
    fail('isEmptySearchPage() missed empty-result copy');
  }

  if (!isEmptySearchPage('<title>Just a moment...</title><body>Checking your browser</body>')) {
    pass('isEmptySearchPage() does not bless challenge pages as empty boards');
  } else {
    fail('isEmptySearchPage() treated a challenge page as empty');
  }

  // ── fetch() end-to-end against a stub ctx (no network) ───────────────────
  const pagesRequested = [];
  const slept = [];
  const stubCtx = {
    async fetchText(url) {
      pagesRequested.push(url);
      // Mirror the live quirk: an out-of-range page re-serves page 1.
      return FIXTURE;
    },
    async sleep(ms) { slept.push(ms); },
  };
  const jobs = await occ.fetch({ name: 'OCC', queries: ['automatizacion'], states: ['nuevo-leon'], max_pages: 3 }, stubCtx);

  if (jobs.length === 3) pass('fetch() dedups by posting id when OCC re-serves page 1');
  else fail(`fetch() returned ${jobs.length} jobs, expected 3 after dedup`);

  if (pagesRequested.length === 2) pass('fetch() stops after the first page that yields no new ids');
  else fail(`fetch() requested ${pagesRequested.length} pages: ${JSON.stringify(pagesRequested)}`);

  if (slept.length === 1 && slept[0] === 750) pass('fetch() paces paginated requests through ctx.sleep');
  else fail(`sleep calls = ${JSON.stringify(slept)}`);

  if (jobs.every(j => j.title && j.url && typeof j.company === 'string' && typeof j.location === 'string')) {
    pass('fetch() returns the normalized {title, url, company, location} shape');
  } else {
    fail(`fetch() shape = ${JSON.stringify(jobs)}`);
  }

  if (jobs[2]?.company === '?') pass('fetch() marks missing employer unknown instead of attributing it to OCC');
  else fail(`missing employer job = ${JSON.stringify(jobs[2])}`);

  const probeRequests = [];
  await occ.fetch({ name: 'OCC', queries: ['a', 'b'], max_pages: 10 }, {
    maxPages: 1,
    async fetchText(url) { probeRequests.push(url); return FIXTURE; },
  });
  if (probeRequests.length === 2) pass('fetch() honors ctx.maxPages for bounded health probes');
  else fail(`probe requested ${probeRequests.length} pages: ${JSON.stringify(probeRequests)}`);

  class FakeProbeBudgetReached extends Error {}
  const sentinel = new FakeProbeBudgetReached('probe budget');
  let rethrown = false;
  try {
    await occ.fetch({ name: 'OCC', queries: ['a'], max_pages: 2 }, {
      maxPages: 1,
      async fetchText() { throw sentinel; },
    });
  } catch (err) {
    rethrown = err === sentinel;
  }
  if (rethrown) pass('fetch() preserves probe sentinel errors from ctx.fetchText');
  else fail('fetch() did not preserve the probe sentinel error');

  const failingCtx = { async fetchText() { throw new Error('boom'); } };
  let outageThrew = false;
  try {
    await occ.fetch({ name: 'OCC', queries: ['a', 'b'], max_pages: 2 }, failingCtx);
  } catch (err) {
    outageThrew = /boom/.test(err?.message || '');
  }
  if (outageThrew) pass('fetch() throws when every OCC request fails');
  else fail('fetch() hid a complete transport outage as an empty board');

  let selectorMissThrew = false;
  try {
    await occ.fetch({ name: 'OCC', queries: ['a'], max_pages: 1 }, {
      async fetchText() { return '<title>Just a moment...</title><body>Checking your browser</body>'; },
    });
  } catch (err) {
    selectorMissThrew = /no parseable job cards/.test(err?.message || '');
  }
  if (selectorMissThrew) pass('fetch() throws on first-page selector miss / challenge HTML');
  else fail('fetch() hid a first-page selector miss as an empty board');

  const empty = await occ.fetch({ name: 'OCC', queries: ['zzznothing'], max_pages: 1 }, {
    async fetchText() { return '<main>No encontramos empleos para esta búsqueda</main>'; },
  });
  if (Array.isArray(empty) && empty.length === 0) pass('fetch() returns [] for an explicit OCC empty-result page');
  else fail(`explicit empty result = ${JSON.stringify(empty)}`);

  // max_pages is bounded so a bad config cannot hammer the site.
  const manyPages = [];
  const countingCtx = {
    async fetchText(url) { manyPages.push(url); return FIXTURE.replace(/21319670/g, String(manyPages.length)); },
    async sleep() {},
  };
  await occ.fetch({ name: 'OCC', queries: ['x'], max_pages: 999 }, countingCtx);
  if (manyPages.length <= 10) pass('fetch() caps max_pages at 10 regardless of config');
  else fail(`fetch() requested ${manyPages.length} pages with max_pages: 999`);

} catch (err) {
  fail(`occ provider test threw: ${err.message}`);
}
