import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseApp, parseAppList, parseAd, dedupe, batches, asoApps, toReport, diff, diffLines, toCsv, toMarkdown, toChat, addCommands } from '../coverage.js';

const run = JSON.parse(readFileSync(new URL('../examples/run.json', import.meta.url)));
const prev = JSON.parse(readFileSync(new URL('../examples/previous.json', import.meta.url)));

test('parseApp takes ids, links and labels', () => {
  assert.deepEqual(parseApp('493145008'), { storeId: '493145008', label: null });
  assert.deepEqual(parseApp('493145008=Headspace'), { storeId: '493145008', label: 'Headspace' });
  assert.deepEqual(parseApp('https://apps.apple.com/us/app/duolingo/id570060128?l=en'), { storeId: '570060128', label: null });
  assert.deepEqual(parseApp('https://apps.apple.com/us/app/duolingo/id570060128=Duo'), { storeId: '570060128', label: 'Duo' });
  assert.throws(() => parseApp('duolingo'), /not an App Store id/);
});

test('parseAppList reads a list file with comments', () => {
  const list = parseAppList(readFileSync(new URL('../examples/competitors.txt', import.meta.url), 'utf8'));
  assert.equal(list.length, 5);
  assert.deepEqual(list[2], { storeId: '1000000003', label: 'Example Grocery List' });
  assert.equal(list[3].label, 'Example Macro Coach');
});

test('parseAd takes platform refs and Meta ad library links', () => {
  assert.deepEqual(parseAd('meta:123'), { platform: 'meta', archiveId: '123' });
  assert.deepEqual(parseAd('paid:tiktok:abc'), { platform: 'tiktok', archiveId: 'abc' });
  assert.deepEqual(parseAd('https://www.facebook.com/ads/library/?id=987654'), { platform: 'meta', archiveId: '987654' });
  assert.throws(() => parseAd('google:1'));
});

test('batches keep to 100 ids per memberships read', () => {
  const ids = Array.from({ length: 250 }, (_, i) => String(1000000000 + i));
  assert.deepEqual(batches(ids).map((b) => b.length), [100, 100, 50]);
});

test('dedupe merges labels and sources, asoApps skips temporary apps', () => {
  const d = dedupe([{ storeId: '1', sources: ['args'] }, { storeId: '1', label: 'A', sources: ['aso'], role: 'mine' }]);
  assert.deepEqual(d, [{ storeId: '1', sources: ['args', 'aso'], label: 'A', role: 'mine' }]);
  const a = asoApps({ data: [{ storeId: '1000000001', name: 'Mine', role: 'mine', kind: 'apple' }, { storeId: null, name: 'Idea', kind: 'temporary' }] });
  assert.deepEqual(a, [{ storeId: '1000000001', label: 'Mine', role: 'mine', sources: ['aso'] }]);
});

test('report groups memberships per app with board names', () => {
  const r = toReport(run);
  assert.equal(r.summary.checked, 5);
  assert.equal(r.summary.missing, 2);
  assert.equal(r.summary.onOneBoardOnly, 2);
  assert.equal(r.summary.onSeveralBoards, 1);
  assert.equal(r.summary.freeSlots, 1);
  const box = r.apps.find((a) => a.storeId === '1000000002');
  assert.deepEqual(box.boards.map((b) => b.boardName), ['Meal planning rivals (example)', 'Pantry apps (example)']);
  assert.equal(r.apps.find((a) => a.storeId === '1000000004').status, 'missing');
});

test('a bare memberships response works with the asked ids', () => {
  const r = toReport({ data: [] }, { apps: [{ storeId: '1' }] });
  assert.equal(r.summary.missing, 1);
  assert.equal(r.boardsInTenancy, null);
});

test('ad mode lists the boards that saved it', () => {
  const r = toReport({ tool: 'board-coverage-check/raw', fetchedAt: null, list: null, apps: null, ad: { platform: 'meta', archiveId: '9' }, memberships: [{ data: [{ boardId: 'b', itemId: 'i', note: 'hook' }] }] });
  assert.equal(r.ad.saved, true);
  assert.match(toMarkdown(r), /saved on 1 board/);
  assert.match(toCsv(r), /meta,9,b,,i,hook/);
});

test('diff finds lost and gained coverage', () => {
  const d = diff(toReport(run), prev);
  assert.deepEqual(d.lostCoverage.map((a) => a.storeId), ['1000000004']);
  assert.deepEqual(d.gainedCoverage.map((a) => a.storeId), ['1000000003']);
  assert.deepEqual(d.boardsChanged.map((a) => a.storeId), ['1000000002']);
  assert.deepEqual(d.addedToList.map((a) => a.storeId), ['1000000005']);
  assert.match(diffLines(d)[0], /no longer on any board/);
  assert.throws(() => diff(toReport(run), { tool: 'other' }));
});

test('outputs: markdown, csv, chat, add commands', () => {
  const r = toReport(run);
  const md = toMarkdown(r, null, { commands: true });
  assert.match(md, /\*\*2 on no board\*\*/);
  assert.match(md, /409 tracked_app_limit/);
  assert.match(md, /"storeId":"1000000005"/);
  const csv = toCsv(r).split('\n');
  assert.equal(csv.length, 1 + 6);
  assert.match(toChat(r), /3\/5 apps on a board, 2 on no board/);
  assert.equal(addCommands(r, 'B').length, 2);
  assert.ok(!md.includes('PEEKPANDA_TOKEN=') && !JSON.stringify(run).includes('Bearer'));
});
