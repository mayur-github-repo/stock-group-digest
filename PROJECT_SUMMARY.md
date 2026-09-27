# stock-group-digest (formerly MSD) — project summary (published 2026-09-27)

An on-demand tool that reads busy Indian stock-market WhatsApp groups (two SME and
microcap discussion groups in the original setup) and hands every message and image to
an AI assistant. The assistant analyses them against a real portfolio, verifies claims on
the web, and keeps one running knowledge file. Built solo, June–September 2026, then
cleaned up and published so anyone can clone it and run it with the AI of their choice.
This file is the retrospective: why it looks the way it does.

## What it does
1. `analyze.py` connects to WhatsApp (via `whatsapp-web.js`, headless, a linked-device
   session — like WhatsApp Web), fetches new messages from the configured groups since
   the last run, and writes them to a plain-text export grouped by chat.
2. A person (via Claude in chat) reads every message and every image in that export,
   checks the interesting claims against the web, and cross-references a holdings file.
3. The findings are merged into one running knowledge file, organised by company, so
   facts from different days connect to each other instead of sitting in separate reports.
4. `analyze.py --mark` then advances a watermark and deletes all downloaded images —
   nothing from the group is stored beyond what was merged into the knowledge file.

## Why it exists
The two groups produce hundreds of messages a day — too many to read live, too much
signal (order wins, promoter/insider deals, results, credible members' watchlists) to
skip. The tool's only job is: don't lose anything worth knowing, and don't make it a
chore to re-find it later.

## History (the short version)
- **June 2026:** started as a scheduled, multi-channel system — a background listener,
  4x/day email + WhatsApp delivery, an AI classify/curate/research pipeline (Gemini/
  Claude/Copilot backends), plus separate `bulk/` (NSE bulk-deal scraper) and `ipo/`
  (IPO/GMP alert) modules feeding the same delivery pipeline.
- **2026-09-09:** pivoted to **on-demand only** — no background daemon, no scheduled
  sends, nothing left running unattended. `analyze.py` becomes the single entry point;
  `now.py` / `schedule_setup.py` (the old scheduler) retired.
- **2026-09-22:** moved analysis **into the chat session itself** — the script stopped
  calling any AI backend (Copilot was policy-blocked in one environment anyway; Gemini
  quota-limited). It only fetches and exports; a person reads the export directly.
  Added: read images, not just note they exist; end-of-run rule (analyse → save →
  delete media).
- **2026-09-25:** replaced one-report-per-run with a **single merged knowledge file**
  (`reports/MSD_KNOWLEDGE.md`) — company-indexed, so a new fact lands next to the old
  ones about the same stock instead of forking into another dated file.
- **2026-09-26:** deleted the entire legacy pipeline (classify/curate/research code,
  Excel signal log, bulk/ipo modules, scheduler, tests, ~15 files) since none of it was
  in use — chat analysis had fully replaced it.
- **2026-09-27:** made portable and published.
  - Deleted the WhatsApp session, the downloaded library and the raw message archive.
  - Squashed the history into one commit. The old history carried ~300 MB of committed
    `node_modules`.
  - Added `AGENTS.md` so any assistant (Claude Code, Codex, Gemini CLI, or a chat-only AI
    fed uploaded files) runs the same workflow.
  - Added a knowledge-file template, `.env.example` and `holdings.example.csv`.
  - Fixed a fetcher bug: messages that arrived during the sync wait were accepted from
    *every* group the phone was in, and all were labelled with one hardcoded group name.

## Final architecture (lean, by design)
```
analyze.py               fetch (WhatsApp) -> export window -> --mark (advance + purge)
                          stdlib-only Python; no AI calls; makes no content decisions
wa/wa_fetch.js            headless, read-only WhatsApp Web client (whatsapp-web.js)
wa/package.json, .lock    its two npm dependencies (whatsapp-web.js, qrcode-terminal)
wa/patches/               one vendored upstream bugfix, reapplied on `npm install`
AGENTS.md                 the AI's operating manual (CLAUDE.md / GEMINI.md point to it)
templates/                skeleton of the knowledge file
holdings.csv              your broker export: personalises the analysis (not committed)
reports/MSD_KNOWLEDGE.md  the one knowledge file, merged by company (not committed)
.env                      local settings: WA_GROUPS, timeouts (not committed)
```
Nothing else. A scheduler, a database, delivery channels and per-run report files were
all tried, then deliberately removed. The standing instruction throughout the project was
to keep it to as few moving parts as possible.

## Key decisions, and why
- **No background activity, ever.** Explicit owner preference: nothing should run on
  the laptop unattended. Every run is invoked by hand.
- **No AI calls inside the script.** The classify/curate/research pipeline was real
  engineering (three-stage, per-company batching, dedup) but added a layer between the
  raw group and the answer. Reading the export directly in a chat session removes that
  layer entirely and reads every image, not just flags that one exists.
- **One knowledge file, not one file per run.** Per-run reports don't connect: a fact
  about a stock from three weeks ago is easy to miss if it's in a different file from
  today's. A single file, organised by company with a running "claims corrected" and
  "open items" section, is where new information is supposed to connect old dots.
- **Read-then-delete media.** Images are analysed for the run that downloaded them, then
  removed. The knowledge file keeps what was learned from them; the images themselves
  are not archived.
- **Content rules that took several rounds to settle** (now in AGENTS.md §3): name
  recognised members explicitly (their identity is part of the signal) but keep
  unnamed phone-number IDs anonymous; verify and silently correct group claims rather
  than flagging them as checked/unchecked; never guess a number (lot size, all-time
  high) — write "n/a" instead; end every researched stock with a fixed stat line
  (segment · price · lot → minimum investment · IPO price/date · returns) because SME
  lot sizes (often a ₹1–3 lakh minimum ticket) decide whether a position is even
  possible before anything else matters.
- **whatsapp-web.js needed a vendored patch.** The released version (1.34.7) crashes
  against the current WhatsApp Web build; the fix exists as an open, unreleased upstream
  PR (wwebjs/whatsapp-web.js#201850). The diff is kept in `wa/patches/` and reapplied
  automatically after every `npm install`. Drop it once a release ≥1.34.8 ships the fix
  upstream.

## What is NOT in this repo, and why
`reports/MSD_KNOWLEDGE.md`, `holdings.csv` and `.env` are git-ignored and have never been
committed.
- The knowledge file holds the owner's real portfolio (share counts, average costs),
  built up over months of analysis.
- `holdings.csv` is the raw broker export.
- `.env` held credentials.

The session, the raw messages and the images are excluded too: they are other people's
messages. To continue on a new machine, clone the repo and copy the private files in by
hand. The README covers the steps.
