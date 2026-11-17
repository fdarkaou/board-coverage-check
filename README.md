# board-coverage-check

You keep a list of the competitor apps you care about: in a spreadsheet, a `competitors.txt` in a repo, or your ASO workspace. PeekPanda only tracks an app while it sits on one of your boards, so the question that matters is: is every app on my list actually on a board? Someone tidies a board, an app falls off, and its paid ads, organic posts, keywords and chart position stop being collected without anyone noticing.

This tool asks PeekPanda which boards hold each app on your list, up to 100 apps per call, and reports the apps on no board, the apps on one board only (taking that item off stops tracking them), board names, item ids and notes. With `--state` it tells you what changed since the last check, with `--fail-on-missing` it fails a CI job, and it can post a short summary to Slack or Discord. It can also tell you which boards saved one paid ad.

Output is Markdown, CSV or JSON. Node 18+, no dependencies, read-only: it never adds or removes board items. With `--commands` it prints the add-item requests for you to review and run yourself. There is also a [browser version](https://fdarkaou.github.io/board-coverage-check/) that reads pasted JSON and never sends anything anywhere.

```
## Board coverage

5 app(s) checked, 3 on a board, **2 on no board** (not tracked in this tenancy), 2 on one board only. 2 board(s) in tenancy 55555555-5555-4555-8555-555555555555. Tracked apps 4 of 5 on panda. Read 2026-11-17.

### Since the last check (2026-11-10)

- no longer on any board, so no longer tracked here: Example Macro Coach (1000000004) (was on Pantry apps (example))
- now on a board: Example Grocery List (1000000003) (Meal planning rivals (example))
- Example Recipe Box (1000000002): +Pantry apps (example)
- new in your list: Example Meal Kit (1000000005) (not on a board)

### On no board

PeekPanda tracks an app in a space while it is on any board there. These are on none, so this tenancy does not collect their paid ads, organic posts, keywords or chart position.

- Example Macro Coach (1000000004)
- Example Meal Kit (1000000005)

The plan has 1 free tracked-app slot(s) and 2 app(s) are on no board, so adding all of them may answer 409 tracked_app_limit (an app already tracked in another space you pay for counts once).

| App | Store id | Boards | Item ids | Notes | Status |
|---|---|---|---|---|---|
| Example Meal Planner | 1000000001 | Meal planning rivals (example) | 77777777-7777-4777-8777-000000000001 | Main rival, watch the UGC hooks | one board only |
| Example Recipe Box | 1000000002 | Meal planning rivals (example), Pantry apps (example) | 77777777-7777-4777-8777-000000000002, 77777777-7777-4777-8777-000000000003 | Also a pantry app | several boards |
| Example Grocery List | 1000000003 | Meal planning rivals (example) | 77777777-7777-4777-8777-000000000004 |  | one board only |
| Example Macro Coach | 1000000004 |  |  |  | on no board |
| Example Meal Kit | 1000000005 |  |  |  | on no board |

"One board only": removing that item stops tracking the app in this tenancy (DELETE /v1/boards/{boardId}/items/{itemId}).
```

(Example data from `examples/`, not real boards or apps.)

## Run it

```sh
export PEEKPANDA_TOKEN=...   # PeekPanda API key; never commit it

# Which tenancies (personal space, workspaces) can this key read? 1 call
node cli.js --workspaces

# A few apps by id or App Store link: 1 workspaces read + 1 board list + 1 memberships read
node cli.js --apps "493145008=Headspace,https://apps.apple.com/us/app/duolingo-language-lessons/id570060128"

# Your list file plus every app tracked in the ASO workspace, with a weekly diff, failing when one is on no board
node cli.js --apps-file competitors.txt --from-aso --state coverage-state.json --fail-on-missing

# Print the add-item requests for the apps on no board (content:write; the tool does not run them)
node cli.js --apps-file competitors.txt --commands --board-id <boardId>

# Which boards saved this ad?
node cli.js --ad meta:<archiveId>

# Re-render a saved run without calling the API
node cli.js --file examples/run.json --format csv
```

`examples/competitors.txt` shows the list format: one App Store id or `apps.apple.com` link per line, an optional `=Label`, and `#` comments. `node cli.js --help` lists every option. `node --test test/` runs the tests. `.github/workflows/board-coverage.yml` is a weekly GitHub Actions example that reads `competitors.txt` from the repository root. It is off until you set the repository variable `ENABLE_BOARD_COVERAGE=true`.

## Where the data comes from

The data comes from [PeekPanda](https://peekpanda.com), an iOS competitor catalogue where every app has a case file of dated, stored evidence. Putting an app on a [board](https://peekpanda.com/docs/boards) tracks it, and each app counts once toward the plan however many boards it is on. The tool calls these reads, all scope `context:read`:

- [`GET /v1/workspaces`](https://peekpanda.com/docs/list-workspaces) (MCP `get_context`, action `workspaces`), only when you do not pass `--tenancy`. With one selector the tool uses it; with several it reads `personal` and tells you. A key pinned to one workspace lists only that workspace (sending `personal` with such a key answers `403 workspace_not_accessible`).
- [`GET /v1/boards`](https://peekpanda.com/docs/list-boards) (MCP `boards`, action `list`), for board names and `trackedAppAllowance` (`used`, `limit`, `plan`). Skipped with `--no-names`.
- [`GET /v1/aso/apps`](https://peekpanda.com/docs/list-aso-apps) (MCP `aso`, action `list`), only with `--from-aso`. Apps with a `storeId` are added to the list with their name and `role`; temporary app ideas without a listing are skipped.
- [`GET /v1/boards/memberships`](https://peekpanda.com/docs/board-memberships) (MCP `boards`, action `memberships`) with `storeIds` (up to 100 comma-separated ids, so the tool splits longer lists), or `platform` + `archiveId` for one ad. Each row is a board that holds the target: `boardId`, `itemId`, `storeId`, `note`.

Each call counts toward your plan's daily API and MCP allowance: 30 a day on Peek, 1,000 a day on Panda, reset at 00:00 UTC. Peek tracks 1 app and Panda 100 ([plans](https://peekpanda.com/docs/plans-and-refreshes)). The tool prints how many calls it used, warns when a run plans more than 30, retries once on `429 rate_limited` with a short `Retry-After`, and stops on `daily_call_limit`. Board reads never call a provider or start collection.

How it reads the answer:

- On no board: no membership row came back for the app in this tenancy, so this tenancy does not track it. It may still be tracked in another space you own; the read only covers the tenancy you named.
- One board only: the docs for [removing a board item](https://peekpanda.com/docs/remove-board-item) say an app on no other board in the tenancy stops being tracked, so these are the apps one cleanup away from dropping out.
- Free slots are `limit − used` from `trackedAppAllowance`. That number covers every space the plan holder pays for, so adding an app already tracked elsewhere does not use a new slot. When there are fewer free slots than missing apps, the tool says adding all of them may answer `409 tracked_app_limit`, which is what [adding a board item](https://peekpanda.com/docs/add-board-item) returns over the allowance.
- The `--state` diff compares apps by store id and boards by id: apps that fell off every board, apps that came back, board moves, and apps added to or dropped from your list.

What it does not do: it does not add or remove anything, and it does not read board evidence (use `GET /v1/boards/{boardId}` for that, as in [board-pulse-report](https://github.com/fdarkaou/board-pulse-report)).

## Use it from an AI agent (MCP)

The PeekPanda MCP server at `https://mcp.peekpanda.com/mcp` exposes the same reads ([tool reference](https://peekpanda.com/docs/mcp-tools)): `boards` with actions `list` and `memberships`, `aso` with action `list`, and `get_context` with action `workspaces`. Clients sign in with OAuth (the server's OAuth metadata lists PKCE `S256` and dynamic client registration) or send an API key as a bearer token on the same URL ([get started](https://peekpanda.com/docs/mcp)). Either way you need a PeekPanda account, and the tokens stay in your client, never in this repo. An agent can call `boards` with `{"action": "memberships", "query": {"storeIds": "493145008,570060128"}}`, save the response and run `node cli.js --file memberships.json`; without the list of ids you asked about, apps on no board cannot show up, so the saved CLI file (`--save`) is the better input.

## Licence

MIT. Example data in `examples/` is made up.
