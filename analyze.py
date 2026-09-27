#!/usr/bin/env python3
"""
MSD — on-demand WhatsApp stock-group fetch for analysis IN CHAT. Nothing runs in the
background and the script makes no AI calls: it fetches once, writes the selected
window to wa/analysis_input.txt, and Claude analyses it in the conversation.

    python3 analyze.py                 # everything since the last analysis
    python3 analyze.py --hours 72      # last 72 hours
    python3 analyze.py --last 300      # last 300 messages
    python3 analyze.py --since 2026-09-08
    python3 analyze.py --no-fetch      # re-export already-captured messages
    python3 analyze.py --link          # (re)link WhatsApp: shows the QR, then fetches
    python3 analyze.py --groups        # list your WhatsApp groups
    python3 analyze.py --mark          # after findings are MERGED into
                                                #   reports/MSD_KNOWLEDGE.md: advance the
                                                #   watermark + delete all downloaded media

Env (.env): WA_GROUPS, WA_SYNC_WAIT, WA_FETCH_TIMEOUT, MSD_MAX_MSGS, WA_WEB_VERSION,
WA_CHATS_RETRIES. The watermark (wa/.last_analyzed) advances only on --mark, so an
interrupted run re-covers the same window — nothing is ever skipped.
"""
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
WA = os.path.join(HERE, "wa")
NODE = os.environ.get("NODE_BIN", "node")   # override in .env if `node` isn't on PATH
FETCH_JS = os.path.join(WA, "wa_fetch.js")
MESSAGES = os.path.join(WA, "messages.jsonl")
MEDIA = os.path.join(WA, "media")
WATERMARK = os.path.join(WA, ".last_analyzed")
PENDING = os.path.join(WA, ".pending_until")
UNREAD = os.path.join(WA, ".unread.json")
INPUT = os.path.join(WA, "analysis_input.txt")
KNOWLEDGE = os.path.join(HERE, "reports", "MSD_KNOWLEDGE.md")   # the ONE report file
TEMPLATE = os.path.join(HERE, "templates", "MSD_KNOWLEDGE.template.md")


# ── helpers ─────────────────────────────────────────────────────────────────
def load_env():
    """Load KEY=VALUE lines from .env into os.environ (existing vars win)."""
    path = os.path.join(HERE, ".env")
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _arg(flag, default=None):
    if flag in sys.argv:
        try:
            return sys.argv[sys.argv.index(flag) + 1]
        except IndexError:
            pass
    return default


def _read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


def _write(path, text):
    with open(path, "w") as f:
        f.write(text)


def _local(ts):
    """'2026-09-09T16:46:00.000Z' -> '09 Sep 22:16' (local time)."""
    try:
        d = datetime.strptime(ts.rstrip("Z").split(".")[0], "%Y-%m-%dT%H:%M:%S")
        return f"{d.replace(tzinfo=timezone.utc).astimezone():%d %b %H:%M}"
    except (ValueError, AttributeError):
        return ts


# ── WhatsApp fetch ──────────────────────────────────────────────────────────
def kill_orphans():
    """Stop leftover headless Chromium holding the session. SIGTERM first —
    SIGKILL mid-write corrupts the session profile."""
    try:
        subprocess.run(["pkill", "-f", "wwebjs_auth"], capture_output=True, timeout=15)
        time.sleep(2)
        if subprocess.run(["pgrep", "-f", "wwebjs_auth"], capture_output=True).returncode == 0:
            subprocess.run(["pkill", "-9", "-f", "wwebjs_auth"], capture_output=True, timeout=15)
    except Exception:  # noqa: BLE001
        pass


def fetch(list_only=False):
    """One-shot fetch: connect, sync, pull the groups, exit."""
    env = os.environ.copy()
    env["WA_MEDIA_AFTER"] = _read(WATERMARK)   # don't re-download already-analysed images
    sync = int(env.get("WA_SYNC_WAIT", "90"))
    budget = int(env.get("WA_FETCH_TIMEOUT", "0")) or (240 + sync)
    cmd = [NODE, FETCH_JS] + (["--list"] if list_only else [])
    try:
        r = subprocess.run(cmd, timeout=budget, capture_output=True, text=True, env=env, cwd=WA)
        out = ((r.stdout or "") + (r.stderr or "")).strip()
        print(out if list_only else ("[fetch] " + (out.splitlines()[-1] if out else "done")))
        if not list_only and "NO GROUP MATCHED" in out:
            print("[fetch] ⚠️  set WA_GROUPS in .env — run `analyze.py --groups` to see names")
    except subprocess.TimeoutExpired:
        print(f"[fetch] timed out after {budget}s — exporting what we already have "
              f"(raise WA_FETCH_TIMEOUT)")
    except Exception as e:  # noqa: BLE001
        print(f"[fetch] failed: {e} — exporting what we already have")
    finally:
        kill_orphans()


def link():
    """Run the fetcher attached to the terminal so the QR code is visible."""
    print("Scan the QR below: WhatsApp ▸ Linked Devices ▸ Link a device. Ctrl-C to abort.\n")
    try:
        subprocess.run([NODE, FETCH_JS], env=os.environ.copy(), timeout=900, cwd=WA)
    except subprocess.TimeoutExpired:
        print("[link] timed out — run again and scan promptly")
    finally:
        kill_orphans()


def purge_media():
    """Images are read for one run only, then deleted (never stored)."""
    n = 0
    for f in (os.listdir(MEDIA) if os.path.isdir(MEDIA) else []):
        fp = os.path.join(MEDIA, f)
        if os.path.isfile(fp) and not f.startswith("."):
            try:
                os.remove(fp)
                n += 1
            except OSError:
                pass
    if n:
        print(f"[media] {n} image(s) deleted after processing")


# ── window selection + export ───────────────────────────────────────────────
def read_messages():
    rows = []
    try:
        with open(MESSAGES) as f:
            for line in f:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    except FileNotFoundError:
        pass
    return rows


def _unread():
    try:
        with open(UNREAD) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def select(msgs):
    """Return (selected, label, newest_ts, skipped) for the requested window."""
    msgs = sorted((m for m in msgs if m.get("body") and m.get("ts")), key=lambda m: m["ts"])
    if not msgs:
        return [], "no messages captured", "", 0
    hours, last, since = _arg("--hours"), _arg("--last"), _arg("--since")
    if hours:
        cut = (datetime.now(timezone.utc) - timedelta(hours=float(hours))).strftime("%Y-%m-%dT%H:%M:%S")
        sel, label = [m for m in msgs if m["ts"] > cut], f"last {hours}h"
    elif last:
        sel, label = msgs[-int(last):], f"last {last} messages"
    elif since:
        sel, label = [m for m in msgs if m["ts"] > since], f"since {since}"
    elif _read(WATERMARK):
        wm = _read(WATERMARK)
        sel, label = [m for m in msgs if m["ts"] > wm], "since your last analysis"
    else:                       # first run: WhatsApp's own unread state, else last 24h
        firsts = [u.get("first_ts") for u in _unread().values() if u.get("first_ts")]
        if firsts:
            sel, label = [m for m in msgs if m["ts"] >= min(firsts)], "your WhatsApp unread messages"
        else:
            cut = (datetime.now(timezone.utc) - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%S")
            sel, label = [m for m in msgs if m["ts"] > cut], "last 24h (first run)"
    cap = int(os.environ.get("MSD_MAX_MSGS", "800"))   # runaway guard; excess is reported
    skipped = max(0, len(sel) - cap)
    sel = sel[-cap:] if skipped else sel
    return sel, label, (sel[-1]["ts"] if sel else ""), skipped


def export(sel, label, newest, skipped):
    """Write the window, grouped by source group, for Claude to analyse in chat."""
    by_group = {}
    for m in sel:
        by_group.setdefault(m.get("group") or "?", []).append(m)
    unread = _unread()
    lines = [f"# MSD analysis input — {label} — {len(sel)} messages, {len(by_group)} group(s)",
             f"# generated {datetime.now():%a %d %b %H:%M}",
             "# images: wa/media/  (each [image: <file>] below is analysable — read it)", ""]
    if skipped:
        lines.append(f"⚠️ {skipped} older message(s) beyond the MSD_MAX_MSGS cap are NOT included.")
    for g, ms in by_group.items():
        u = unread.get(g) or {}
        wa_unread = f" | WhatsApp unread at fetch: {u.get('count')}" if u else ""
        lines += [f"## {g} — {len(ms)} new message(s){wa_unread}",
                  f"first: {_local(ms[0]['ts'])}  ·  last: {_local(ms[-1]['ts'])}", ""]
        for m in ms:
            body = " ".join((m.get("body") or "").split())
            mp = m.get("media_path") or ""
            med = f"  [image: {os.path.basename(mp)}]" if mp else ""
            lines.append(f"[{_local(m['ts'])}] {m.get('sender') or '?'}: {body}{med}")
        lines.append("")
    _write(INPUT, "\n".join(lines))
    if newest:
        _write(PENDING, newest)


def mark():
    """Advance the watermark and purge media — only once the knowledge file was
    updated after this export (so nothing is lost)."""
    pending = _read(PENDING)
    if not pending:
        print("[mark] nothing pending — run analyze.py first")
        return
    since = os.path.getmtime(INPUT) if os.path.exists(INPUT) else 0
    saved = os.path.isfile(KNOWLEDGE) and os.path.getmtime(KNOWLEDGE) >= since
    if not saved and "--force" not in sys.argv:
        print("[mark] reports/MSD_KNOWLEDGE.md not updated for this run — merge the findings "
              "first (media NOT deleted, watermark NOT advanced). Use --force to override.")
        return
    _write(WATERMARK, pending)
    os.remove(PENDING)
    purge_media()
    print(f"[mark] watermark advanced to {pending} — next run starts after it")


def main():
    load_env()
    if "--link" in sys.argv:
        link()
    elif "--groups" in sys.argv:
        fetch(list_only=True)
    elif "--mark" in sys.argv:
        mark()
    else:
        if "--no-fetch" not in sys.argv:
            fetch()
        sel, label, newest, skipped = select(read_messages())
        if not sel:
            print(f"📊 No new messages ({label}). Watermark unchanged.")
            purge_media()
            return
        # Fresh clone: seed the knowledge file BEFORE exporting, so its mtime is older
        # than the export and --mark still demands a real merge.
        if not os.path.exists(KNOWLEDGE) and os.path.exists(TEMPLATE):
            os.makedirs(os.path.dirname(KNOWLEDGE), exist_ok=True)
            with open(TEMPLATE) as src, open(KNOWLEDGE, "w") as dst:
                dst.write(src.read())
            print(f"[knowledge] created {KNOWLEDGE} from the template")
            time.sleep(1)                     # guarantee a strictly newer export mtime
        export(sel, label, newest, skipped)
        print(f"[export] {len(sel)} messages ({label}) -> {INPUT}")
        print("[export] analyse in chat, merge into reports/MSD_KNOWLEDGE.md, then: "
              "python3 analyze.py --mark")


if __name__ == "__main__":
    main()
