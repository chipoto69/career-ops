// tests/providers/kalibrr.test.mjs — Kalibrr provider parser and HTML cleanup coverage.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — kalibrr');
try {
  const kalibrrModule = await import(pathToFileURL(join(ROOT, 'providers/kalibrr.mjs')).href);
  const kalibrr = kalibrrModule.default;

  if (kalibrr.id === 'kalibrr') pass('kalibrr.id is "kalibrr"');
  else fail(`kalibrr.id is ${JSON.stringify(kalibrr.id)}`);

  if (kalibrr.detect({ careers_url: 'https://www.kalibrr.com/c/acme/jobs' }) === null) {
    pass('kalibrr.detect() stays explicit-provider only');
  } else {
    fail('kalibrr.detect() should not auto-detect aggregator URLs');
  }

  const calls = [];
  const mkItem = (id, overrides = {}) => ({
    id,
    slug: `role-${id}`,
    name: `Role ${id}`,
    company_name: 'Acme',
    company: { code: 'acme', name: 'Acme Inc' },
    google_location: { address_components: { city: 'Jakarta', region: 'Jakarta' } },
    activation_date: '2026-09-01T00:00:00Z',
    application_end_date: '2999-01-01T00:00:00Z',
    description: '<p>Hello&nbsp;&amp;&nbsp;welcome<br>Line two</p>',
    qualifications: '<ul><li>Own &quot;quality&quot;</li><li>Don&#39;t regress</li></ul>',
    ...overrides,
  });
  const ctx = {
    fetchJson: async (url) => {
      calls.push(url);
      const offset = Number(new URL(url).searchParams.get('offset'));
      if (offset === 0) return { jobs: [mkItem(1), mkItem(1), mkItem(2, { application_end_date: '2000-01-01T00:00:00Z' })] };
      return { jobs: [] };
    },
  };

  const jobs = await kalibrr.fetch({ provider: 'kalibrr', searchKeywords: 'engineer', pageSize: 2, maxPages: 2 }, ctx);
  if (jobs.length === 1 && jobs[0].url === 'https://www.kalibrr.com/c/acme/jobs/1/role-1') {
    pass('kalibrr.fetch() builds canonical URLs, dedups, and drops expired postings');
  } else {
    fail(`kalibrr.fetch() returned wrong jobs: ${JSON.stringify(jobs)}`);
  }

  if (jobs[0].location === 'Jakarta, Jakarta' && jobs[0].company === 'Acme') {
    pass('kalibrr.fetch() maps company and structured location');
  } else {
    fail(`kalibrr.fetch() mapped wrong metadata: ${JSON.stringify(jobs[0])}`);
  }

  if (jobs[0].description.includes('Hello & welcome\nLine two') && jobs[0].description.includes('• Own "quality"') && jobs[0].description.includes("• Don't regress")) {
    pass('kalibrr.fetch() strips markup and decodes entities without double-escaped regexes');
  } else {
    fail(`kalibrr.fetch() produced wrong description: ${JSON.stringify(jobs[0].description)}`);
  }

  const first = new URL(calls[0]);
  if (first.searchParams.get('limit') === '2' && first.searchParams.get('offset') === '0' && first.searchParams.get('country') === 'Indonesia' && first.searchParams.get('text') === 'engineer') {
    pass('kalibrr.fetch() sends expected search params');
  } else {
    fail(`kalibrr.fetch() sent wrong URL: ${calls[0]}`);
  }
} catch (e) {
  fail(`kalibrr provider tests crashed: ${e.message}`);
}
