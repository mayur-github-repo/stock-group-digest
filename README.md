# stock-group-digest

Read busy stock-market WhatsApp groups with an AI assistant, without drowning in them.
(Originally built as "MSD", which is why the knowledge file is named `MSD_KNOWLEDGE.md`.)

Indian SME and small-cap investing groups on WhatsApp post hundreds of messages a day:
order wins, results screenshots, promoter deals, watchlists from credible members, and a
lot of noise. MSD fetches those groups on demand and hands the messages and images to an
AI assistant (Claude Code, Codex, Gemini CLI, or any chat AI). The assistant reads
**everything**, checks the claims on the web, relates them to **your** holdings, and keeps
one running knowledge file organised by company, so today's news connects to last month's.

- **On demand only.** Nothing runs in the background and nothing is ever sent to WhatsApp.
- **No AI inside the script.** `analyze.py` just fetches and exports; your assistant does the
  thinking, following [AGENTS.md](AGENTS.md).
- **Private by default.** Your holdings, knowledge file, session and messages are git-ignored.

> ⚠️ **Disclaimers.** This is not investment advice. It organises what a group said and what
> public sources confirm, and the decisions are yours. It uses
> [whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js), an **unofficial**
> WhatsApp Web client. Automating WhatsApp may break its Terms of Service and risk a ban on
> the linked number, so use it sparingly and at your own risk. Respect the privacy of group
> members: don't publish their messages.

## Quick start
Requires **Node.js 18+**, **Python 3.9+** (standard library only), and a phone with WhatsApp
that's in the groups you want to follow.
```
git clone https://github.com/mayur-github-repo/stock-group-digest.git && cd stock-group-digest
cd wa && npm install && cd ..          # installs whatsapp-web.js and applies the patch
cp .env.example .env
python3 analyze.py --link              # scan the QR: WhatsApp ▸ Linked Devices ▸ Link a device
python3 analyze.py --groups            # list group names → set WA_GROUPS in .env
cp holdings.example.csv holdings.csv   # then replace it with your broker's holdings export
```
Then open the folder in your AI assistant and ask something like *"analyse the last 3 days
of the groups against my holdings"*. Claude Code picks up `CLAUDE.md`, Gemini CLI `GEMINI.md`,
and Codex `AGENTS.md`; all three lead to the same instructions.

## How a run works
```
python3 analyze.py [--hours 72 | --since 2026-09-20 | --last 500]
```
1. Fetch: new messages and images from `WA_GROUPS` go to `wa/analysis_input.txt` and
   `wa/media/`.
2. The assistant reads every message and image, verifies claims on the web, and reports in
   chat: your holdings first, then a table of every stock mentioned.
3. The assistant **merges** the findings into `reports/MSD_KNOWLEDGE.md`, the single knowledge
   file. It's created from `templates/` on first use.
4. `python3 analyze.py --mark` advances the watermark and deletes the images. It refuses
   until the knowledge file has been updated, so no window is ever skipped.

Busy groups or long windows: `MSD_MAX_MSGS=4000 WA_FETCH_TIMEOUT=900 WA_SYNC_WAIT=60 python3 analyze.py --hours 72`.
Other flags: `--no-fetch` (re-export what's already captured) and `--link` (re-link WhatsApp).
Using a chat-only AI with no shell, such as ChatGPT or Gemini in a browser? See
[AGENTS.md §6](AGENTS.md#6-chat-only-assistants-no-shell-or-file-access).

## Files
| Path | What |
|---|---|
| `analyze.py` | The only script: fetch → export → `--mark` |
| `wa/wa_fetch.js` | Headless WhatsApp Web fetcher (read-only) |
| `wa/package.json`, `wa/patches/` | Node deps plus a vendored upstream fix (see Gotchas) |
| `AGENTS.md` (+ `CLAUDE.md`, `GEMINI.md`) | Operating manual for the AI: workflow, report rules, knowledge-file rules |
| `templates/MSD_KNOWLEDGE.template.md` | Skeleton of the knowledge file |
| `.env.example`, `holdings.example.csv` | Settings and holdings format |
| `PROJECT_SUMMARY.md` | Why and how this was built, and the key decisions |

Created locally and never committed: `.env`, `holdings.csv`, `reports/`, `wa/messages.jsonl`
(raw archive), `wa/media/`, `wa/.wwebjs_auth/` (session), `wa/.last_analyzed` (watermark),
`wa/node_modules/`.

## Settings (`.env`)
- `WA_GROUPS`: comma-separated, case-insensitive substrings of group names. Quote it.
- `WA_SYNC_WAIT`: history-sync wait in seconds (default 90).
- `WA_FETCH_TIMEOUT`: default 240 + sync.
- `MSD_MAX_MSGS`: window cap (default 800). Any excess is reported, never silently dropped.
- `WA_CHATS_RETRIES`, `WA_WEB_VERSION`, `NODE_BIN`: rarely needed.

## Moving to a new laptop or phone number
Clone and run the Quick start. Scanning the QR with whichever phone you now use creates a
fresh session. Bring your private `reports/MSD_KNOWLEDGE.md` and `holdings.csv` separately
(keep them somewhere private, not in this repo) and drop them in place.

## Gotchas
- **`getChats()` crash (`r: r`) in whatsapp-web.js 1.34.7.** WhatsApp changed internal IDs.
  The fix is upstream PR [#201850](https://github.com/wwebjs/whatsapp-web.js/pull/201850),
  vendored in `wa/patches/` and re-applied by `npm install`. Drop it once a release that
  includes the fix ships.
- **Only one process can hold the session.** `analyze.py` kills orphaned headless Chromium
  after each fetch.
- **Session expired or unlinked:** run `python3 analyze.py --link` again.
- **A fetch timeout exports stale data.** Raise `WA_FETCH_TIMEOUT`.
- **Window larger than the cap:** raise `MSD_MAX_MSGS`.

## License
[MIT](LICENSE). Free to use, change and share. No warranty: see the disclaimers above.
