// SPDX-License-Identifier: GPL-3.0-or-later
// /admin: the visit counts (worker/index.ts countVisit) read back from Workers Analytics Engine through its SQL API.
// Off unless ADMIN_PASSWORD, CF_ACCOUNT_ID and CF_API_TOKEN (Account Analytics: Read) are set; HTTP Basic auth.

export interface AdminEnv {
  ADMIN_PASSWORD?: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
}

export const DATASET = 'd2_webgpu_visits';

/** blob columns written by countVisit, in order */
const COLUMNS = { browser: 'blob1', browserMajor: 'blob2', os: 'blob3', webgpu: 'blob4', vendor: 'blob5', architecture: 'blob6', features: 'blob7', jspi: 'blob8', country: 'index1' } as const;

/** one or two columns per breakdown; two are grouped together and joined in adminStats (no string functions in SQL) */
const BREAKDOWNS: Record<string, [string] | [string, string]> = {
  country: [COLUMNS.country],
  webgpu: [COLUMNS.webgpu],
  browser: [COLUMNS.browser, COLUMNS.browserMajor],
  os: [COLUMNS.os],
  gpu: [COLUMNS.vendor, COLUMNS.architecture],
  features: [COLUMNS.features],
  jspi: [COLUMNS.jspi],
};
const JOIN: Record<string, string> = { browser: ' ', gpu: ' / ' };

export function adminEnabled(env: AdminEnv): boolean {
  return !!(env.ADMIN_PASSWORD && env.CF_ACCOUNT_ID && env.CF_API_TOKEN);
}

/** the SQL for one panel; `days` is clamped to 1..90 (Analytics Engine keeps 3 months) */
export function statsQueries(daysIn: number): Record<string, string> {
  const days = Math.min(90, Math.max(1, Math.floor(daysIn) || 30));
  const since = `timestamp > NOW() - INTERVAL '${days}' DAY`;
  const out: Record<string, string> = {
    daily: `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS k, SUM(_sample_interval) AS n FROM ${DATASET} WHERE ${since} GROUP BY k ORDER BY k`,
  };
  for (const [name, [a, b]] of Object.entries(BREAKDOWNS)) {
    const cols = b ? `${a} AS k, ${b} AS k2` : `${a} AS k`;
    const group = b ? 'k, k2' : 'k';
    out[name] = `SELECT ${cols}, SUM(_sample_interval) AS n FROM ${DATASET} WHERE ${since} GROUP BY ${group} ORDER BY n DESC LIMIT 50`;
  }
  return out;
}

async function sql(env: AdminEnv, query: string, join = ' '): Promise<{ k: string; n: number }[]> {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
    body: query,
  });
  if (!r.ok) throw new Error(`Analytics Engine SQL ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const body = (await r.json()) as { data?: { k: unknown; k2?: unknown; n: unknown }[] };
  return (body.data ?? []).map((row) => ({
    k: row.k2 === undefined ? String(row.k ?? '') : [row.k, row.k2].map((v) => String(v ?? '')).filter(Boolean).join(join),
    n: Number(row.n) || 0,
  }));
}

export async function adminStats(env: AdminEnv, url: URL): Promise<Response> {
  const queries = statsQueries(Number(url.searchParams.get('days') ?? 30));
  try {
    const entries = await Promise.all(Object.entries(queries).map(async ([name, q]) => [name, await sql(env, q, JOIN[name])] as const));
    return Response.json(Object.fromEntries(entries), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}

export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>d2-webgpu visits</title>
<style>
  :root { color-scheme: dark; --bg: #0c0c0f; --fg: #d8d2c0; --dim: #8a8577; --line: #2a2822; --acc: #c9a14a; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
  header { display: flex; gap: 12px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--line); }
  h1 { font-size: 16px; margin: 0; color: var(--acc); font-weight: 600; }
  select { background: #18171b; color: var(--fg); border: 1px solid var(--line); border-radius: 4px; padding: 2px 6px; font: inherit; }
  #total { margin-left: auto; color: var(--dim); }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; padding: 16px; }
  section { border: 1px solid var(--line); border-radius: 6px; padding: 12px; min-width: 0; }
  section.wide { grid-column: 1 / -1; }
  h2 { font-size: 13px; margin: 0 0 8px; color: var(--dim); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 0; vertical-align: middle; }
  td.k { width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 0; }
  td.n { width: 3.5em; text-align: right; font-variant-numeric: tabular-nums; padding-left: 8px; }
  .bar { height: 10px; background: var(--acc); border-radius: 2px; min-width: 1px; }
  .days { display: flex; align-items: flex-end; gap: 2px; height: 120px; }
  .days div { flex: 1; background: var(--acc); border-radius: 2px 2px 0 0; min-height: 1px; }
  .err { color: #e07a5f; padding: 16px; }
  .dim { color: var(--dim); }
</style>
</head>
<body>
<header>
  <h1>d2-webgpu visits</h1>
  <select id="days" aria-label="Period">
    <option value="1">24 hours</option><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option>
  </select>
  <span id="total"></span>
</header>
<main id="out"><p class="dim">Loading&hellip;</p></main>
<script>
const TITLES = { daily: 'Visits per day', webgpu: 'WebGPU', country: 'Country', browser: 'Browser', os: 'OS', gpu: 'GPU vendor / architecture', features: 'WebGPU features', jspi: 'JSPI' };
const out = document.getElementById('out');
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function table(rows) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return '<table>' + rows.map((r) => '<tr><td class="k" title="' + esc(r.k) + '">' + (esc(r.k.trim()) || '<span class="dim">(none)</span>') +
    '</td><td><div class="bar" style="width:' + (100 * r.n / max).toFixed(1) + '%"></div></td><td class="n">' + Math.round(r.n) + '</td></tr>').join('') + '</table>';
}
function days(rows) {
  if (!rows.length) return '<p class="dim">No visits yet.</p>';
  const max = Math.max(1, ...rows.map((r) => r.n));
  return '<div class="days">' + rows.map((r) => '<div style="height:' + (100 * r.n / max).toFixed(1) + '%" title="' + esc(r.k.slice(0, 10)) + ': ' + Math.round(r.n) + '"></div>').join('') + '</div>';
}
async function load() {
  const d = document.getElementById('days').value;
  out.innerHTML = '<p class="dim">Loading&hellip;</p>';
  try {
    const r = await fetch('/admin/api/stats?days=' + d, { cache: 'no-store' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.status);
    const total = (data.webgpu || []).reduce((a, r) => a + r.n, 0);
    document.getElementById('total').textContent = Math.round(total) + ' visits';
    out.innerHTML = Object.keys(TITLES).map((k) => '<section' + (k === 'daily' ? ' class="wide"' : '') + '><h2>' + TITLES[k] + '</h2>' +
      (k === 'daily' ? days(data[k] || []) : (data[k] || []).length ? table(data[k]) : '<p class="dim">No data.</p>') + '</section>').join('');
  } catch (e) {
    out.innerHTML = '<p class="err">' + esc(e.message || e) + '</p>';
  }
}
document.getElementById('days').addEventListener('change', load);
load();
</script>
</body>
</html>
`;
