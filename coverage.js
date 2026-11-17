// Board coverage logic for PeekPanda board memberships. No dependencies; runs in Node 18+ and in the browser.
// Input: the raw file the CLI saves (GET /v1/boards/memberships batches + optional GET /v1/boards and GET /v1/aso/apps),
// or a single memberships response plus the list of store ids you asked about.

export const MAX_IDS_PER_CALL = 100; // GET /v1/boards/memberships: storeIds takes up to 100 comma-separated ids

// "1234567890", "1234567890=My label", "https://apps.apple.com/us/app/name/id1234567890" (optionally "=Label")
export function parseApp(token) {
  const s = String(token ?? '').trim();
  if (!s || s.startsWith('#')) return null;
  const eq = s.lastIndexOf('=');
  let ref = s, label = null;
  // a link can carry "?l=en", so only treat "=" as a label separator when the left side is an id or a link path
  if (eq > 0) {
    const left = s.slice(0, eq).trim();
    if (/^\d{5,12}$/.test(left) || /\/id\d{5,12}\/?$/.test(left)) { ref = left; label = s.slice(eq + 1).trim() || null; }
  }
  let id = null;
  if (/^\d{5,12}$/.test(ref)) id = ref;
  else {
    const m = ref.match(/apps\.apple\.com\/.*?\bid(\d{5,12})\b/);
    if (m) id = m[1];
  }
  if (!id) throw new Error(`"${s}" is not an App Store id or an apps.apple.com link.`);
  return { storeId: id, label };
}

export function parseAppList(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const clean = line.replace(/(^|\s)#.*$/, '').trim();
    if (!clean || clean.startsWith('#')) continue;
    for (const part of clean.split(',')) {
      const a = parseApp(part);
      if (a) out.push(a);
    }
  }
  return out;
}

// "meta:123", "tiktok:abc", "paid:tiktok:abc", or a Meta ad library link (?id=...)
export function parseAd(token) {
  const s = String(token ?? '').trim();
  const lib = s.match(/facebook\.com\/ads\/library\/?\?(?:.*&)?id=(\d+)/);
  if (lib) return { platform: 'meta', archiveId: lib[1] };
  const m = s.replace(/^paid:/, '').match(/^(meta|tiktok):(.+)$/);
  if (!m) throw new Error(`"${s}" is not an ad (use meta:<archiveId>, tiktok:<archiveId> or a Meta ad library link).`);
  return { platform: m[1], archiveId: m[2] };
}

export function dedupe(apps) {
  const seen = new Map();
  for (const a of apps) {
    const prev = seen.get(a.storeId);
    if (!prev) seen.set(a.storeId, { ...a });
    else {
      if (!prev.label && a.label) prev.label = a.label;
      prev.sources = [...new Set([...(prev.sources ?? []), ...(a.sources ?? [])])];
      if (!prev.role && a.role) prev.role = a.role;
    }
  }
  return [...seen.values()];
}

export function batches(ids, size = MAX_IDS_PER_CALL) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

const rows = (r) => (Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : []);

// Apps from GET /v1/aso/apps (kind apple with a store id; temporary app ideas have no listing yet)
export function asoApps(asoResponse) {
  return rows(asoResponse)
    .filter((a) => a && a.storeId && /^\d{5,12}$/.test(String(a.storeId)))
    .map((a) => ({ storeId: String(a.storeId), label: a.name ?? null, role: a.role ?? null, sources: ['aso'] }));
}

export function toReport(input, opts = {}) {
  if (input?.tool === 'board-coverage-check') return input; // already a report
  let raw = input;
  if (input?.tool !== 'board-coverage-check/raw') {
    // a bare memberships response: needs opts.apps to know what was asked
    if (!Array.isArray(input?.data) && !Array.isArray(input)) throw new Error('Expected the file this tool saves, or a GET /v1/boards/memberships response.');
    raw = { tool: 'board-coverage-check/raw', fetchedAt: opts.fetchedAt ?? null, tenancy: null, list: opts.list ?? null, aso: null, apps: opts.apps ?? null, ad: opts.ad ?? null, memberships: [input] };
  }
  const listRows = rows(raw.list);
  const names = new Map(listRows.map((b) => [b.id, b]));
  const found = raw.memberships.flatMap(rows).map((m) => ({
    boardId: m.boardId, boardName: names.get(m.boardId)?.name ?? null, itemId: m.itemId ?? null,
    storeId: m.storeId != null ? String(m.storeId) : null, platform: m.platform ?? null, archiveId: m.archiveId ?? null, note: m.note ?? null,
  }));

  const report = {
    tool: 'board-coverage-check', version: 1,
    fetchedAt: raw.fetchedAt ?? null, tenancy: raw.tenancy ?? null,
    boardsInTenancy: raw.list ? listRows.length : null,
    allowance: raw.list?.trackedAppAllowance ?? raw.aso?.trackedAppAllowance ?? null,
    mode: raw.ad ? 'ad' : 'apps',
  };

  if (raw.ad) {
    const hits = found; // one ad target per read, so every row is a board that saved it
    report.ad = { ...raw.ad, saved: hits.length > 0, boards: hits.map(({ boardId, boardName, itemId, note }) => ({ boardId, boardName, itemId, note })) };
    return report;
  }

  let asked = raw.apps;
  if (!asked) asked = dedupe(found.filter((m) => m.storeId).map((m) => ({ storeId: m.storeId, label: null })));
  const byApp = new Map();
  for (const m of found) {
    if (!m.storeId) continue;
    if (!byApp.has(m.storeId)) byApp.set(m.storeId, []);
    const list = byApp.get(m.storeId);
    if (!list.some((x) => x.itemId && x.itemId === m.itemId)) list.push({ boardId: m.boardId, boardName: m.boardName, itemId: m.itemId, note: m.note });
  }
  report.apps = asked.map((a) => {
    const boards = byApp.get(a.storeId) ?? [];
    return {
      storeId: a.storeId, label: a.label ?? null, role: a.role ?? null, sources: a.sources ?? null,
      boards, onBoards: boards.length,
      // An app on any board in a space is tracked there; removing it from its only board stops tracking it.
      status: boards.length === 0 ? 'missing' : boards.length === 1 ? 'single' : 'covered',
    };
  });
  const missing = report.apps.filter((a) => a.status === 'missing');
  const al = report.allowance;
  report.summary = {
    checked: report.apps.length,
    onABoard: report.apps.length - missing.length,
    missing: missing.length,
    onOneBoardOnly: report.apps.filter((a) => a.status === 'single').length,
    onSeveralBoards: report.apps.filter((a) => a.status === 'covered').length,
    unexpected: [...byApp.keys()].filter((id) => !asked.some((a) => a.storeId === id)),
    freeSlots: al && Number.isFinite(al.limit) && Number.isFinite(al.used) ? Math.max(0, al.limit - al.used) : null,
  };
  return report;
}

export function diff(cur, prev) {
  if (!prev || prev.tool !== 'board-coverage-check' || prev.mode !== 'apps' || cur.mode !== 'apps') throw new Error('not comparable');
  const before = new Map(prev.apps.map((a) => [a.storeId, a]));
  const now = new Map(cur.apps.map((a) => [a.storeId, a]));
  const out = { lostCoverage: [], gainedCoverage: [], boardsChanged: [], addedToList: [], removedFromList: [], since: prev.fetchedAt ?? null };
  for (const a of cur.apps) {
    const p = before.get(a.storeId);
    if (!p) { out.addedToList.push(a); continue; }
    if (p.onBoards > 0 && a.onBoards === 0) out.lostCoverage.push({ ...a, previousBoards: p.boards });
    else if (p.onBoards === 0 && a.onBoards > 0) out.gainedCoverage.push(a);
    else {
      const pb = new Set(p.boards.map((b) => b.boardId)), nb = new Set(a.boards.map((b) => b.boardId));
      const added = a.boards.filter((b) => !pb.has(b.boardId)), removed = p.boards.filter((b) => !nb.has(b.boardId));
      if (added.length || removed.length) out.boardsChanged.push({ ...a, added, removed });
    }
  }
  for (const p of prev.apps) if (!now.has(p.storeId)) out.removedFromList.push(p);
  return out;
}

const nm = (a) => (a.label ? `${a.label} (${a.storeId})` : a.storeId);
const bn = (b) => b.boardName ?? b.boardId;

export function diffLines(d) {
  const l = [];
  for (const a of d.lostCoverage) l.push(`no longer on any board, so no longer tracked here: ${nm(a)} (was on ${a.previousBoards.map(bn).join(', ')})`);
  for (const a of d.gainedCoverage) l.push(`now on a board: ${nm(a)} (${a.boards.map(bn).join(', ')})`);
  for (const a of d.boardsChanged) l.push(`${nm(a)}: ${[...a.added.map((b) => `+${bn(b)}`), ...a.removed.map((b) => `−${bn(b)}`)].join(' ')}`);
  for (const a of d.addedToList) l.push(`new in your list: ${nm(a)}${a.onBoards ? '' : ' (not on a board)'}`);
  for (const a of d.removedFromList) l.push(`dropped from your list: ${nm(a)}`);
  return l;
}

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function addCommands(report, boardId = '<boardId>', tenancy = report.tenancy ?? '<tenancy>') {
  const miss = (report.apps ?? []).filter((a) => a.status === 'missing');
  return miss.map((a) => `curl --request POST 'https://api.peekpanda.com/v1/boards/${boardId}/items' \\\n  --header "Authorization: Bearer $PEEKPANDA_TOKEN" \\\n  --header 'x-genviral-tenancy: ${tenancy}' \\\n  --header 'content-type: application/json' \\\n  --data '{"kind":"app","storeId":"${a.storeId}"}'`);
}

export function toMarkdown(r, d = null, opts = {}) {
  const L = [];
  const al = r.allowance;
  const read = r.fetchedAt ? ` Read ${r.fetchedAt.slice(0, 10)}.` : '';
  if (r.mode === 'ad') {
    L.push('## Board coverage: one ad', '');
    L.push(`${r.ad.platform}:${r.ad.archiveId} is ${r.ad.saved ? `saved on ${r.ad.boards.length} board(s)` : 'not saved on any board'} in tenancy ${r.tenancy ?? '(not recorded)'}.${read}`, '');
    if (r.ad.boards.length) {
      L.push('| Board | Board id | Item id | Note |', '|---|---|---|---|');
      for (const b of r.ad.boards) L.push(`| ${esc(b.boardName ?? '')} | ${b.boardId} | ${b.itemId ?? ''} | ${esc(b.note ?? '')} |`);
    }
    return L.join('\n');
  }
  const s = r.summary;
  L.push('## Board coverage', '');
  L.push(`${s.checked} app(s) checked, ${s.onABoard} on a board, **${s.missing} on no board** (not tracked in this tenancy), ${s.onOneBoardOnly} on one board only.` +
    (r.boardsInTenancy != null ? ` ${r.boardsInTenancy} board(s) in tenancy ${r.tenancy ?? ''}.` : '') +
    (al ? ` Tracked apps ${al.used} of ${al.limit} on ${al.plan}.` : '') + read, '');
  if (d) {
    const lines = diffLines(d);
    L.push(`### Since the last check${d.since ? ` (${d.since.slice(0, 10)})` : ''}`, '');
    L.push(...(lines.length ? lines.map((x) => `- ${x}`) : ['- No changes.']), '');
  }
  const miss = r.apps.filter((a) => a.status === 'missing');
  if (miss.length) {
    L.push('### On no board', '');
    if (r.boardsInTenancy === 0) L.push('This tenancy has no boards yet, so every app is on none.', '');
    L.push('PeekPanda tracks an app in a space while it is on any board there. These are on none, so this tenancy does not collect their paid ads, organic posts, keywords or chart position.', '');
    for (const a of miss) L.push(`- ${nm(a)}${a.role ? `, ASO role ${a.role}` : ''}`);
    if (s.freeSlots != null) L.push('', s.freeSlots >= miss.length
      ? `The plan has ${s.freeSlots} free tracked-app slot(s); adding all ${miss.length} needs at most ${miss.length} (an app already tracked in another space you pay for counts once).`
      : `The plan has ${s.freeSlots} free tracked-app slot(s) and ${miss.length} app(s) are on no board, so adding all of them may answer 409 tracked_app_limit (an app already tracked in another space you pay for counts once).`);
    L.push('');
  }
  L.push('| App | Store id | Boards | Item ids | Notes | Status |', '|---|---|---|---|---|---|');
  const label = { missing: 'on no board', single: 'one board only', covered: 'several boards' };
  for (const a of r.apps) L.push(`| ${esc(a.label ?? '')} | ${a.storeId} | ${esc(a.boards.map(bn).join(', '))} | ${a.boards.map((b) => b.itemId ?? '').join(', ')} | ${esc(a.boards.map((b) => b.note).filter(Boolean).join('; '))} | ${label[a.status]} |`);
  if (s.unexpected.length) L.push('', `Returned but not asked for: ${s.unexpected.join(', ')}.`);
  if (s.onOneBoardOnly) L.push('', '"One board only": removing that item stops tracking the app in this tenancy (DELETE /v1/boards/{boardId}/items/{itemId}).');
  if (miss.length && opts.commands) {
    L.push('', `### Add them (content:write, not run by this tool)`, '', '```sh', ...addCommands(r, opts.boardId, opts.tenancy), '```');
  }
  return L.join('\n');
}

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function toCsv(r) {
  const out = [];
  if (r.mode === 'ad') {
    out.push(['platform', 'archive_id', 'board_id', 'board_name', 'item_id', 'note'].join(','));
    for (const b of r.ad.boards) out.push([r.ad.platform, r.ad.archiveId, b.boardId, b.boardName, b.itemId, b.note].map(csvCell).join(','));
    if (!r.ad.boards.length) out.push([r.ad.platform, r.ad.archiveId, '', '', '', ''].map(csvCell).join(','));
    return out.join('\n');
  }
  out.push(['store_id', 'label', 'status', 'boards_count', 'board_id', 'board_name', 'item_id', 'note'].join(','));
  for (const a of r.apps) {
    if (!a.boards.length) out.push([a.storeId, a.label, a.status, 0, '', '', '', ''].map(csvCell).join(','));
    for (const b of a.boards) out.push([a.storeId, a.label, a.status, a.onBoards, b.boardId, b.boardName, b.itemId, b.note].map(csvCell).join(','));
  }
  return out.join('\n');
}

export function toChat(r, d = null) {
  if (r.mode === 'ad') return `PeekPanda board coverage: ad ${r.ad.platform}:${r.ad.archiveId} ${r.ad.saved ? `saved on ${r.ad.boards.map(bn).join(', ')}` : 'not saved on any board'}.`;
  const s = r.summary;
  const lines = [`PeekPanda board coverage: ${s.onABoard}/${s.checked} apps on a board, ${s.missing} on no board.`];
  const miss = r.apps.filter((a) => a.status === 'missing');
  if (miss.length) lines.push(`Not tracked here: ${miss.slice(0, 15).map(nm).join(', ')}${miss.length > 15 ? ` and ${miss.length - 15} more` : ''}`);
  if (d) for (const x of diffLines(d).slice(0, 10)) lines.push(`• ${x}`);
  return lines.join('\n');
}
