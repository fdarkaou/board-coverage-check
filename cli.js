#!/usr/bin/env node
// Board coverage check for PeekPanda. Node 18+, no dependencies. Read-only.
//   GET /v1/workspaces           tenancy selectors this credential may use (MCP get_context workspaces), only when --tenancy is not given
//   GET /v1/boards               board names + tracked-app allowance (MCP boards list), skipped with --no-names
//   GET /v1/aso/apps             tracked ASO apps as an extra id source (MCP aso list), only with --from-aso
//   GET /v1/boards/memberships   which boards hold up to 100 apps per call, or one paid ad (MCP boards memberships)
// Board reads never call a provider or start collection.
import { readFile, writeFile } from 'node:fs/promises';
import { parseApp, parseAppList, parseAd, dedupe, batches, asoApps, toReport, toMarkdown, toCsv, toChat, diff } from './coverage.js';

const HELP = `Usage:
  PEEKPANDA_TOKEN=... node cli.js --apps <ids|links> [opts]        which boards hold these apps
  PEEKPANDA_TOKEN=... node cli.js --apps-file competitors.txt      one id or apps.apple.com link per line (optional =Label, # comments)
  PEEKPANDA_TOKEN=... node cli.js --from-aso                       check the apps you track in the ASO workspace
  PEEKPANDA_TOKEN=... node cli.js --ad meta:<archiveId>            which boards saved one paid ad
  PEEKPANDA_TOKEN=... node cli.js --workspaces                     list the tenancy selectors for this key
  node cli.js --file run.json [opts]                               re-render a saved run or report

Options:
  --apps <list>            comma-separated App Store ids or apps.apple.com links, "id=Label" allowed; repeatable
  --apps-file <path>       a list file (see above); can be combined with --apps and --from-aso
  --from-aso               also read GET /v1/aso/apps and check every tracked App Store app
  --ad <ref>               meta:<archiveId>, tiktok:<archiveId>, paid:tiktok:<archiveId> or a Meta ad library link
  --tenancy <selector>     x-genviral-tenancy: personal or a workspace id. When left out, the tool reads
                           GET /v1/workspaces first and uses the only selector, or personal when there are several.
  --no-names               skip GET /v1/boards (no board names or allowance, one call fewer)
  --fail-on-missing        exit with code 2 when an app is on no board (for CI)
  --commands               print the POST /v1/boards/{boardId}/items commands for apps on no board (not run)
  --board-id <uuid>        board id to put in those commands
  --state <path>           compare with the report saved at this path, then save this run there
  --save <path>            save the raw responses (re-render later with --file)
  --format md|csv|json     output format (default md; json is this tool's report)
  --webhook <url>          also POST a short summary to a Slack or Discord incoming webhook
  --api <url>              API base (default https://api.peekpanda.com)

Calls per run: 1 workspaces read (skipped with --tenancy) + 1 board list (skipped with --no-names)
+ 1 ASO list (with --from-aso) + 1 memberships read per 100 apps (or 1 for --ad).
Every call counts toward your plan's daily API and MCP allowance (Peek 30, Panda 1,000, reset 00:00 UTC).`;

const FLAGS = new Set(['--help', '-h', '--workspaces', '--from-aso', '--no-names', '--fail-on-missing', '--commands']);
function parse(argv) {
  const o = { format: 'md', api: 'https://api.peekpanda.com', apps: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS.has(a)) o[a === '-h' ? 'help' : a.slice(2)] = true;
    else if (a === '--apps') {
      const v = argv[++i];
      if (v == null) throw new Error('--apps needs a value.');
      o.apps.push(...String(v).split(',').map(parseApp).filter(Boolean).map((x) => ({ ...x, sources: ['args'] })));
    } else if (a.startsWith('--')) {
      const v = argv[++i];
      if (v == null) throw new Error(`${a} needs a value. See --help.`);
      o[a.slice(2)] = v;
    } else throw new Error(`Unexpected argument "${a}". See --help.`);
  }
  return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;

async function call(o, path, retried = false) {
  const token = process.env.PEEKPANDA_TOKEN;
  if (!token) throw new Error('Set PEEKPANDA_TOKEN to a PeekPanda API key (Account → API keys). Never commit it.');
  calls++;
  const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  if (o.tenancy) headers['x-genviral-tenancy'] = o.tenancy;
  const res = await fetch(new URL(path, o.api), { headers });
  if (res.ok) return res.json();
  const body = await res.json().catch(() => null);
  const code = body?.error?.code ?? '';
  const retry = Number(res.headers.get('retry-after') ?? body?.error?.retryAfterSeconds);
  // 429 rate_limited: honor a short Retry-After once. daily_call_limit: stop.
  if (code === 'rate_limited' && !retried && retry > 0 && retry <= 70) {
    await sleep(retry * 1000);
    return call(o, path, true);
  }
  const hints = {
    daily_call_limit: ' The daily API and MCP allowance is used until 00:00 UTC; stopping.',
    subscription_required: ' This read needs a plan with API access.',
    authorization_required: ' Check the credential scopes (context:read).',
    workspace_not_accessible: ' The key cannot reach that tenancy. Run with --workspaces to see the selectors it can use.',
    invalid_request: ' Check the store ids (numeric) or the ad reference.',
  };
  const err = new Error(`PeekPanda API ${res.status} ${code} (GET ${path.split('?')[0]}): ${String(body?.error?.message ?? res.statusText).replace(/\.$/, '')}.${hints[code] ?? ''}`);
  err.code = code;
  throw err;
}

async function pickTenancy(o) {
  const ws = await call(o, '/v1/workspaces');
  const rows = Array.isArray(ws?.data) ? ws.data : [];
  if (o.workspaces) return rows;
  if (rows.length === 1) return rows[0].selector;
  if (rows.some((r) => r.selector === 'personal')) {
    if (rows.length > 1) console.error(`Note: this key can use ${rows.length} tenancies; reading personal. Pass --tenancy <selector> for another (see --workspaces).`);
    return 'personal';
  }
  if (!rows.length) throw new Error('GET /v1/workspaces listed no tenancy for this key.');
  throw new Error(`This key can use several workspaces; pass --tenancy with one of: ${rows.map((r) => `${r.selector} (${r.name})`).join(', ')}`);
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.help) { console.log(HELP); return; }
  if (!['md', 'csv', 'json'].includes(o.format)) throw new Error('--format must be md, csv or json');
  if (o['board-id'] && !/^[0-9a-f-]{36}$/i.test(o['board-id'])) throw new Error('--board-id must be a board uuid');

  if (o.workspaces) {
    const rows = await pickTenancy(o);
    for (const r of rows) console.log(`${r.selector}\t${r.kind}\t${r.name}`);
    console.error(`${calls} API call(s) used.`);
    return;
  }

  let input;
  if (o.file) input = JSON.parse(await readFile(o.file, 'utf8'));
  else {
    const ad = o.ad ? parseAd(o.ad) : null;
    let apps = [...o.apps];
    if (o['apps-file']) apps.push(...parseAppList(await readFile(o['apps-file'], 'utf8')).map((x) => ({ ...x, sources: ['file'] })));
    if (ad && (apps.length || o['from-aso'])) throw new Error('Use --ad on its own: the memberships read takes one target form.');
    if (!ad && !apps.length && !o['from-aso']) throw new Error('Name apps with --apps, --apps-file or --from-aso, or one ad with --ad. See --help.');
    const fetchedAt = new Date().toISOString();
    if (!o.tenancy) o.tenancy = await pickTenancy(o);
    const list = o['no-names'] ? null : await call(o, '/v1/boards');
    let aso = null;
    if (o['from-aso']) {
      aso = await call(o, '/v1/aso/apps');
      const found = asoApps(aso);
      if (!found.length) console.error('Note: the ASO workspace lists no tracked App Store apps in this tenancy.');
      apps.push(...found);
    }
    apps = dedupe(apps);
    const memberships = [];
    if (ad) memberships.push(await call(o, `/v1/boards/memberships?platform=${encodeURIComponent(ad.platform)}&archiveId=${encodeURIComponent(ad.archiveId)}`));
    else {
      const parts = batches(apps.map((a) => a.storeId));
      if (calls + parts.length > 30) console.error(`Note: about ${calls + parts.length} calls; Peek allows 30 API and MCP calls a UTC day.`);
      for (const ids of parts) memberships.push(await call(o, `/v1/boards/memberships?storeIds=${ids.join(',')}`));
    }
    input = { tool: 'board-coverage-check/raw', fetchedAt, tenancy: o.tenancy, list, aso, apps: ad ? null : apps, ad, memberships };
    if (o.save) await writeFile(o.save, JSON.stringify(input, null, 2));
    console.error(`${calls} API call(s) used.`);
  }
  const report = toReport(input);

  let d = null;
  if (o.state && report.mode === 'apps') {
    const prev = await readFile(o.state, 'utf8').then(JSON.parse).catch(() => null);
    if (prev) { try { d = diff(report, prev); } catch { console.error(`Note: ${o.state} is not a board-coverage-check report, so no comparison was made. It will be replaced.`); } }
    await writeFile(o.state, JSON.stringify(report, null, 2));
  }

  if (o.format === 'json') console.log(JSON.stringify(report, null, 2));
  else if (o.format === 'csv') console.log(toCsv(report));
  else console.log(toMarkdown(report, d, { commands: o.commands, boardId: o['board-id'] }));

  if (o.webhook) {
    const text = toChat(report, d);
    const isDiscord = /discord(app)?\.com\/api\/webhooks/.test(o.webhook);
    const r = await fetch(o.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(isDiscord ? { content: text.slice(0, 1900) } : { text }) });
    if (!r.ok) throw new Error(`Webhook returned ${r.status}`);
  }
  if (o['fail-on-missing'] && report.mode === 'apps' && report.summary.missing > 0) process.exitCode = 2;
}

main().catch((e) => { console.error(e.message); process.exit(1); });
