/**
 * WhatsApp fetcher — connect with the saved session, pull NEW messages from the
 * target group(s), download image media, write everything to messages.jsonl,
 * then EXIT. No 24/7 process.
 *
 * Run on demand by analyze.py. First time / re-link: if the session is gone it
 * prints a QR to scan, then fetches.
 *
 * Each message line in messages.jsonl:
 *   {id, ts, group, sender_id, sender, body,
 *    media_type?, media_path?, media_mime?}   // media_* present only for saved media
 * Image files land in wa/media/<id>.<ext>; media_path is relative to this dir.
 *
 * Env:
 *   WA_GROUPS       comma-separated substrings of group names to match
 *                   (e.g. "Microcaps,Stock Discussion"). Falls back to WA_GROUP.
 *   WA_GROUP        single substring (legacy; default "SME")
 *   WA_FETCH_LIMIT  max messages to scan per group (default 1000)
 *   WA_SINCE_HOURS  if >0, fetch last N hours instead of "since last saved"
 *   WA_SAVE_MEDIA   "0" disables media download (default on)
 *   WA_MEDIA_TYPES  csv of message types to save (default "image"; e.g. "image,document")
 *   WA_MEDIA_MAX    cap downloads this run (default 0 = unlimited) — useful for a test pull
 *
 * Modes:
 *   node wa_fetch.js                 incremental fetch (+ media)
 *   node wa_fetch.js --backfill N    ignore cutoff, pull up to N msgs/group;
 *                                          reports oldest reachable msg, and (if media
 *                                          enabled) downloads images for that window
 *   node wa_fetch.js --scan-media    COUNT image messages in the window, download
 *                                          NOTHING (cheap — sizes the job)
 */
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// Match ANY of these substrings (case-insensitive). Supports several groups —
// a group inside a WhatsApp Community is a normal group and matches the same way.
const GROUP_MATCHES = (process.env.WA_GROUPS || process.env.WA_GROUP || 'SME')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const OUT = path.join(__dirname, 'messages.jsonl');
const MEDIA_DIR = path.join(__dirname, 'media');
const FETCH_LIMIT = parseInt(process.env.WA_FETCH_LIMIT || '1000', 10);
const SINCE_HOURS = parseInt(process.env.WA_SINCE_HOURS || '0', 10);

const argv = process.argv.slice(2);
const bfIdx = argv.indexOf('--backfill');
const BACKFILL = bfIdx >= 0 ? parseInt(argv[bfIdx + 1] || '50000', 10) : 0;
const SCAN_ONLY = argv.includes('--scan-media');
const LIST_ONLY = argv.includes('--list');

const SAVE_MEDIA = (process.env.WA_SAVE_MEDIA || '1') !== '0';
const MEDIA_TYPES = (process.env.WA_MEDIA_TYPES || 'image').split(',').map(s => s.trim()).filter(Boolean);
const MEDIA_MAX = parseInt(process.env.WA_MEDIA_MAX || '0', 10);   // 0 = unlimited

// Clear stale Chromium singleton locks so a restart never fails.
const SESSION_DIR = path.join(__dirname, '.wwebjs_auth', 'session');
for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  try { fs.rmSync(path.join(SESSION_DIR, f), { force: true }); } catch (_) {}
}

const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
              'image/webp': 'webp', 'image/gif': 'gif' };
const extFor = (mime) => EXT[mime] || (mime && mime.split('/')[1]) || 'bin';
const safeName = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_');

// Load existing records keyed by id (so a full rewrite never drops history).
function loadRecords() {
  const byId = new Map();
  let maxTs = 0;
  try {
    for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.id) byId.set(r.id, r);
        const t = Date.parse(r.ts);
        if (t > maxTs) maxTs = t;
      } catch (_) {}
    }
  } catch (_) {}
  return { byId, maxTs };
}

// WA_WEB_VERSION pins the WhatsApp Web build the client loads (served from the local
// .wwebjs_cache). Use it when the library falls out of sync with WhatsApp's current
// build and getChats()/fetchMessages() throw minified errors ('r').
const WEB_VERSION = (process.env.WA_WEB_VERSION || '').trim();
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  ...(WEB_VERSION ? {
    webVersion: WEB_VERSION,
    webVersionCache: { type: 'local', path: path.join(__dirname, '.wwebjs_cache'), strict: true },
  } : {}),
});
if (WEB_VERSION) console.log('[web] pinned WhatsApp Web build ' + WEB_VERSION);

client.on('qr', (qr) => {
  console.log('\nNot linked — scan this in WhatsApp > Linked Devices:\n');
  qrcode.generate(qr, { small: true });
});

// Collect messages received in real-time while connected (before the history pull)
const liveMessages = [];
client.on('message', (msg) => {
  if (!msg.isStatus) liveMessages.push(msg);
});

client.on('ready', async () => {
  try {
    // Wait for WhatsApp Web to sync AND receive live messages via WebSocket.
    // The longer we wait, the more real-time messages arrive. 90s is enough for
    // the WebSocket to deliver any messages from the last few hours.
    const syncWait = parseInt(process.env.WA_SYNC_WAIT || '90', 10);
    console.log(`[sync] waiting ${syncWait}s for messages to arrive via WebSocket...`);
    await new Promise(r => setTimeout(r, syncWait * 1000));
    console.log(`[sync] ${liveMessages.length} message(s) arrived during wait`);

    const { byId, maxTs } = loadRecords();
    const limit = BACKFILL > 0 ? BACKFILL : FETCH_LIMIT;
    const cutoff = BACKFILL > 0 ? 0
      : (SINCE_HOURS > 0 ? Date.now() - SINCE_HOURS * 3600 * 1000 : maxTs);
    if (SAVE_MEDIA && !SCAN_ONLY) fs.mkdirSync(MEDIA_DIR, { recursive: true });
    if (BACKFILL > 0) console.log(`[backfill] pulling up to ${limit} msg(s)/group...`);
    if (SCAN_ONLY) console.log('[scan-media] counting image messages, downloading nothing...');

    // A freshly linked session keeps syncing history AFTER 'ready'; getChats() throws
    // (minified 'r') until the chat store is populated. Retry inside this one session
    // instead of killing the browser (which restarts the sync from scratch).
    let chats = null;
    const tries = parseInt(process.env.WA_CHATS_RETRIES || '8', 10);
    for (let t = 1; t <= tries; t++) {
      try { chats = await client.getChats(); break; }
      catch (e) {
        console.log(`[chats] not ready yet (try ${t}/${tries}: ${(e && e.message) || e}) — waiting 60s`);
        if (t === tries) throw e;
        await new Promise(r => setTimeout(r, 60000));
      }
    }
    if (LIST_ONLY) {                       // discover exact group names, fetch nothing
      console.log('Groups visible to this account:');
      for (const c of chats.filter(c => c.isGroup)) console.log('  - ' + (c.name || '(unnamed)'));
      return;
    }
    const groups = chats.filter(c => c.isGroup &&
      GROUP_MATCHES.some(g => (c.name || '').toLowerCase().includes(g)));
    console.log('[groups] matched: ' + (groups.map(g => g.name).join(' | ') || '(none)'));
    if (!groups.length) {
      console.error('NO GROUP MATCHED ' + JSON.stringify(GROUP_MATCHES) + '. All groups:');
      for (const c of chats.filter(c => c.isGroup)) console.error('  - ' + c.name);
    }
    const unreadInfo = {};                 // per-group WhatsApp unread state -> .unread.json

    const nameCache = {};
    let added = 0, mediaSaved = 0, mediaFail = 0, mediaSkipped = 0, imgMsgs = 0;
    let oldestMs = Infinity;

    for (const chat of groups) {
      const msgs = await chat.fetchMessages({ limit });
      if (msgs.length) oldestMs = Math.min(oldestMs, msgs[0].timestamp * 1000);
      const unread = Math.max(0, chat.unreadCount || 0);
      const tail = unread ? msgs.slice(-unread) : [];
      unreadInfo[chat.name] = {
        count: unread,
        first_ts: tail.length ? new Date(tail[0].timestamp * 1000).toISOString() : null,
        last_ts: tail.length ? new Date(tail[tail.length - 1].timestamp * 1000).toISOString() : null,
        fetched_at: new Date().toISOString(),
      };
      console.log(`  ${chat.name}: ${msgs.length} msg(s) available in web store, unread=${unread}`);

      for (const m of msgs) {
        const id = (m.id && (m.id._serialized || m.id)) || '';
        if (!id) continue;
        const tsMs = m.timestamp * 1000;
        const isNew = tsMs > cutoff && !byId.has(id);
        // Read-then-delete policy: media older than the last DELIVERED report was
        // already read + purged — never re-download it (WA_MEDIA_AFTER = ms epoch).
        const MEDIA_AFTER = Date.parse(process.env.WA_MEDIA_AFTER || '') || 0;
        const wantMedia = SAVE_MEDIA && m.hasMedia && MEDIA_TYPES.includes(m.type)
          && tsMs > MEDIA_AFTER;
        if (wantMedia) imgMsgs++;

        // ── media: download if wanted, not already on disk, under the cap ──
        let mediaInfo = null;
        if (wantMedia) {
          const prev = byId.get(id);
          const have = prev && prev.media_path && fs.existsSync(path.join(__dirname, prev.media_path));
          if (have) {
            mediaInfo = { media_type: prev.media_type, media_path: prev.media_path, media_mime: prev.media_mime };
          } else if (SCAN_ONLY) {
            // counting only
          } else if (MEDIA_MAX > 0 && mediaSaved >= MEDIA_MAX) {
            mediaSkipped++;   // hit the per-run cap; leave for a later full pull
          } else {
            try {
              const md = await m.downloadMedia();
              if (md && md.data) {
                const fn = `${safeName(id)}.${extFor(md.mimetype)}`;
                fs.writeFileSync(path.join(MEDIA_DIR, fn), Buffer.from(md.data, 'base64'));
                mediaInfo = { media_type: m.type, media_path: path.join('media', fn), media_mime: md.mimetype };
                mediaSaved++;
              } else { mediaFail++; }   // media expired / unavailable on server
            } catch (_) { mediaFail++; }
          }
        }

        // ── record: write/merge if it's a new message or we just saved media ──
        if (!SCAN_ONLY && (isNew || mediaInfo)) {
          const sid = m.author || m.from;
          if (nameCache[sid] === undefined) {
            let n = '';
            try { const c = await m.getContact(); n = c.pushname || c.name || c.number || ''; } catch (_) {}
            nameCache[sid] = n;
          }
          const prev = byId.get(id) || {};
          const rec = {
            id,
            ts: prev.ts || new Date(tsMs).toISOString(),
            group: prev.group || chat.name,
            sender_id: prev.sender_id || sid,
            sender: prev.sender || nameCache[sid],
            body: (m.body !== undefined && m.body !== '') ? m.body : (prev.body || ''),
          };
          const mi = mediaInfo || (prev.media_path ? {
            media_type: prev.media_type, media_path: prev.media_path, media_mime: prev.media_mime } : null);
          if (mi) Object.assign(rec, mi);
          if (isNew && !byId.has(id)) added++;
          byId.set(id, rec);
        }
      }
    }

    // Also process messages received LIVE via WebSocket during the sync wait
    // These are the truly fresh ones that fetchMessages() may not have.
    // Keep ONLY the target groups, labelled with their real names (previously every
    // group chat was accepted and all were labelled with one hardcoded name).
    const chatId = c => String((c.id && (c.id._serialized || c.id)) || '');
    const targetName = new Map(groups.map(c => [chatId(c), c.name]));
    const liveGroups = liveMessages.filter(m => targetName.has(String(m.from || '')));
    let liveAdded = 0;
    for (const m of liveGroups) {
      const id = (m.id && (m.id._serialized || m.id)) || '';
      if (!id || byId.has(id)) continue;
      const sid = m.author || m.from;
      if (nameCache[sid] === undefined) {
        let n = '';
        try { const c = await m.getContact(); n = c.pushname || c.name || c.number || ''; } catch (_) {}
        nameCache[sid] = n;
      }
      const tsMs = m.timestamp * 1000;
      const rec = {
        id,
        ts: new Date(tsMs).toISOString(),
        group: targetName.get(String(m.from)),
        sender_id: sid,
        sender: nameCache[sid],
        body: m.body || '',
      };
      byId.set(id, rec);
      liveAdded++;
    }
    if (liveAdded) console.log(`[live] ${liveAdded} additional message(s) from WebSocket`);
    added += liveAdded;

    // Rewrite the whole file from the union (chronological, deduped). Never drops history.
    if (!SCAN_ONLY) {
      const all = [...byId.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      const tmp = OUT + '.tmp';
      fs.writeFileSync(tmp, all.map(r => JSON.stringify(r)).join('\n') + (all.length ? '\n' : ''));
      fs.renameSync(tmp, OUT);
      fs.writeFileSync(path.join(__dirname, '.unread.json'), JSON.stringify(unreadInfo, null, 2));
      console.log(`records: ${all.length} total, ${added} new -> ${OUT}`);
    }
    console.log(`media: ${imgMsgs} image-msg(s) in window | ${mediaSaved} saved, ${mediaSkipped} capped, ${mediaFail} unavailable`);
    if (BACKFILL > 0 && oldestMs !== Infinity) {
      const oldest = new Date(oldestMs);
      const days = Math.round((Date.now() - oldestMs) / 86400000);
      console.log(`[backfill] oldest reachable message: ${oldest.toISOString()} (~${days} day(s) back)`);
    }
  } catch (e) {
    console.error('fetch error:', (e && e.stack) || (e && e.message) || String(e));
    process.exitCode = 1;                 // surface failure to the caller
  } finally {
    try { await client.destroy(); } catch (_) {}
    process.exit(0);
  }
});

client.initialize();
