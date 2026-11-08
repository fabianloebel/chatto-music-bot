// Chatto music bot: @mention commands in a room -> joins that room's call and plays audio.
import { createClient } from '@chatto/client';
import { createVoiceCallAPI } from '@chatto/client/api/voiceCalls';
import { createRoomDirectoryAPI, RoomKind } from '@chatto/client/api/roomDirectory';
import { createRoomCommandAPI } from '@chatto/client/api/rooms';
import { Room, AudioSource, AudioFrame, LocalAudioTrack, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { bestMatch, fmt, cut, table, card, parseTime, move, skipTo, shuffled } from './lib.mjs';
const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = process.env;
const TOKEN = env.CHATTO_BOT_TOKEN, URL_ = env.CHATTO_URL, LIVEKIT_URL = env.LIVEKIT_URL;
for (const [k, v] of Object.entries({ CHATTO_BOT_TOKEN: TOKEN, CHATTO_URL: URL_, LIVEKIT_URL })) {
  if (!v) { console.error(`Missing required environment variable ${k} (see .env.example)`); process.exit(1); }
}
const API_URL = new globalThis.URL('/api/connect', URL_).toString();
const CFG = {
  ALONE_GRACE_MS: Number(env.ALONE_GRACE_MS ?? 20_000),   // leave this long after the last human left
  IDLE_MS: Number(env.IDLE_MS ?? 5 * 60_000),             // leave after this long with nothing playing
  MAX_TRACK_SEC: Number(env.MAX_TRACK_SEC ?? 30 * 60),    // reject longer tracks (live streams are allowed)
  MAX_QUEUE: Number(env.MAX_QUEUE ?? 50),
  REQUIRE_LISTENER: (env.REQUIRE_LISTENER ?? 'true') === 'true', // only people in the call may control playback
  AUTOJOIN_MS: Number(env.AUTOJOIN_MS ?? 60_000),
  DATA_FILE: env.DATA_FILE ?? '/data/state.json',
  NORMALIZE: (env.NORMALIZE ?? 'true') === 'true',        // even out loudness between tracks
  HEALTH_FILE: env.HEALTH_FILE ?? '/tmp/healthy',         // touched while connected; used by the Docker healthcheck
};
const RATE = 48000, FRAME = 480; // 10 ms frames
const CH = (process.env.STEREO ?? 'true') === 'false' ? 1 : 2; // stereo by default; STEREO=false publishes mono
const players = new Map(); // roomId -> Player

// ---- persistence (saved queues + favorites), plain JSON on a Docker volume ----
let state = { lists: {}, favs: {}, volumes: {}, resume: {} };
try { state = { ...state, ...JSON.parse(fs.readFileSync(CFG.DATA_FILE, 'utf8')) }; } catch {}
function save() {
  try { fs.mkdirSync(path.dirname(CFG.DATA_FILE), { recursive: true }); fs.writeFileSync(CFG.DATA_FILE, JSON.stringify(state)); }
  catch (e) { console.error('could not save state:', e.message); }
}
const slim = (t) => ({ title: t.title, dur: t.dur, secs: t.secs, url: t.url, id: t.id, channel: t.channel });

// ---- yt-dlp helpers (no shell; user input only ever passed as plain arguments) ----
const PRINT = '%(title)s\t%(duration_string)s\t%(webpage_url,url)s\t%(duration)s\t%(id)s\t%(channel,uploader)s';
const parseRows = (out) => out.trim().split('\n').filter(Boolean).map((l) => {
  const [title, dur, url, secs, id, channel] = l.split('\t');
  return { title, dur: dur === 'NA' ? 'live' : dur, url, secs: secs === 'NA' ? null : Number(secs), id, channel };
});
async function ytdlp(args) {
  const { stdout } = await exec('yt-dlp', ['-q', '--js-runtimes', 'node', '--print', PRINT, ...args], { maxBuffer: 10 * 1024 * 1024, timeout: 60_000 });
  return parseRows(stdout);
}
const target = (q) => (/^https?:\/\//.test(q) ? q : `ytsearch1:${q}`);
const SMART_SEARCH = (env.SMART_SEARCH ?? 'true') === 'true';
const resolveOne = async (q) => {
  if (SMART_SEARCH && !/^https?:\/\//.test(q)) {
    const best = bestMatch(q, await ytdlp(['--flat-playlist', '--', `ytsearch8:${q}`]), CFG.MAX_TRACK_SEC);
    if (best) return best;
  }
  return (await ytdlp(['--no-playlist', '--', target(q)]))[0];
};
const resolveMany = (url, n) => ytdlp(['--flat-playlist', '--playlist-end', String(n), '--', url]);
const search = (q, n = 5) => ytdlp(['--flat-playlist', '--', `ytsearch${n}:${q}`]);
const related = (id) => ytdlp(['--flat-playlist', '--playlist-end', '20', '--', `https://www.youtube.com/watch?v=${id}&list=RD${id}`]);

let failures = 0; // consecutive playback failures: a restart self-updates yt-dlp

class Player {
  constructor(roomId, voice, notify) {
    Object.assign(this, { roomId, voice, notify, queue: [], current: null, history: [], loop: 'off', radio: false, paused: false,
      volume: state.volumes[roomId] ?? 100, votes: new Set(), sent: 0, offset: 0, seekReq: null, ff: null, dl: null, room: null, running: false, abort: false, stopped: false,
      aloneTimer: null, idleTimer: null, lastSearch: [], gen: 0 });
  }
  // ---- call connection ----
  async connect() {
    if (this.room) return;
    await this.voice.joinCall(this.roomId);
    const t = await this.voice.createCallToken(this.roomId);
    if (!t) throw new Error('no call token: start a call in this room first (and check the bot has call.join)');
    const room = new Room();
    room.on('encryptionError', (e) => console.error('E2EE error:', e.message));
    room.on('disconnected', () => { this.room = null; this.halt(); clearTimeout(this.aloneTimer); clearTimeout(this.idleTimer); players.delete(this.roomId); });
    room.on('participantConnected', () => this.checkAlone());
    room.on('participantDisconnected', () => this.checkAlone());
    await room.connect(LIVEKIT_URL, t.token, { autoSubscribe: false, dynacast: false,
      encryption: { keyProviderOptions: { sharedKey: new TextEncoder().encode(t.e2eeKey) } } });
    this.room = room;
    console.log(`[${this.roomId}] in call; participants:`, [...room.remoteParticipants.values()].map((p) => p.identity));
    this.checkAlone(); this.armIdle();
    this.source = new AudioSource(RATE, CH);
    const track = LocalAudioTrack.createAudioTrack('music', this.source);
    await room.localParticipant.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
  }
  get listeners() { return this.room ? this.room.remoteParticipants.size : 0; }
  isListener(userId) {
    if (!CFG.REQUIRE_LISTENER || !this.room) return true;
    const ids = [...this.room.remoteParticipants.values()].map((p) => p.identity);
    if (ids.includes(userId)) return true;
    // identities are not Chatto user ids on this server -> cannot verify, so do not lock people out
    return !ids.some((i) => /^U[A-Za-z0-9]{10,}$/.test(i));
  }
  checkAlone() {
    clearTimeout(this.aloneTimer); this.aloneTimer = null;
    if (!this.room || this.listeners > 0) return;
    this.aloneTimer = setTimeout(() => { if (this.room && this.listeners === 0) this.autoLeave('Everyone left the call, so I left too.'); }, CFG.ALONE_GRACE_MS);
  }
  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.current && !this.queue.length) this.autoLeave('Idle for a while, leaving the call.'); }, CFG.IDLE_MS);
  }
  async autoLeave(msg) { await this.leave(); players.delete(this.roomId); this.notify(this.roomId, msg).catch(() => {}); }

  // ---- queue / playback ----
  add(items, front = false) { if (front) this.queue.unshift(...items); else this.queue.push(...items); this.stopped = false; this.run(); }
  async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.room && !this.stopped) {
        let item, start = 0;
        const seeking = this.seekReq != null && this.current;
        if (seeking) { item = this.current; start = this.seekReq; this.seekReq = null; }
        else {
          item = await this.pick();
          if (!item) { this.current = null; this.armIdle(); break; }
          if (item.at) { start = item.at; item = { ...item }; delete item.at; } // resumed after a restart
          this.current = item; this.votes.clear(); clearTimeout(this.idleTimer);
        }
        if (!seeking && start === 0 && !(this.loop === 'track' && this.history.at(-1)?.id === item.id)) this.notify(this.roomId, card(item, { volume: this.volume, loop: this.loop, radio: this.radio, queued: this.queue.length })).catch((e) => console.error('card failed:', e.message));
        const result = await this.playOne(item, start);
        if (this.seekReq != null && !this.stopped) continue; // seek / restart: play the same track again from the new position
        this.history.push(item); if (this.history.length > 30) this.history.shift();
        if (!this.stopped && result !== 'failed') {
          if (this.loop === 'track' && result === 'done') this.queue.unshift(item);
          else if (this.loop === 'queue') this.queue.push(item);
        }
        if (result === 'failed') {
          this.notify(this.roomId, `Could not play **${item.title}**.`).catch(() => {});
          if (++failures >= 3) { console.error('3 playback failures in a row, restarting to update yt-dlp'); state.resume = {}; save(); this.notify(this.roomId, 'Playback keeps failing, restarting to update my downloader. Try again in a minute.').finally(() => process.exit(1)); return; }
        } else failures = 0;
      }
    } finally { this.running = false; this.current = this.stopped ? null : this.current; }
  }
  async pick() {
    if (this.queue.length) return this.queue.shift();
    if (!this.radio) return null;
    const last = this.history.at(-1);
    if (!last?.id) return null;
    try {
      const seen = new Set(this.history.map((h) => h.id));
      const pool = (await related(last.id)).filter((r) => r.id && !seen.has(r.id) && (r.secs == null || r.secs <= CFG.MAX_TRACK_SEC));
      const next = pool[Math.floor(Math.random() * pool.length)];
      return next ?? null;
    } catch (e) { console.error('radio failed:', e.message); return null; }
  }
  async playOne(item, start = 0) {
    this.abort = false; this.sent = 0; this.offset = start;
    const gen = ++this.gen; // a newer playback invalidates every older one
    console.log(`[${this.roomId}] start: ${item.title}`);
    const dl = spawn('yt-dlp', ['-q', '--js-runtimes', 'node', '--no-playlist', '-f', 'bestaudio', '-o', '-', '--', item.url], { stdio: ['ignore', 'pipe', 'inherit'] });
    const ff = spawn('ffmpeg', ['-loglevel', 'error', ...(start > 0 ? ['-ss', String(start)] : []), '-i', 'pipe:0',
      ...(CFG.NORMALIZE ? ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'] : []), '-f', 's16le', '-ar', String(RATE), '-ac', String(CH), 'pipe:1'], { stdio: ['pipe', 'pipe', 'inherit'] });
    dl.stdout.pipe(ff.stdin); dl.stdout.on('error', () => {}); ff.stdin.on('error', () => {});
    this.dl = dl; this.ff = ff; let buf = Buffer.alloc(0);
    try {
      for await (const chunk of ff.stdout) {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= FRAME * CH * 2) {
          while (this.paused && !this.abort) await sleep(100);
          if (this.abort || gen !== this.gen) return 'aborted';
          const f = new Int16Array(FRAME * CH), vol = this.volume / 100;
          for (let i = 0; i < FRAME * CH; i++) f[i] = Math.max(-32768, Math.min(32767, Math.round(buf.readInt16LE(i * 2) * vol)));
          buf = buf.subarray(FRAME * CH * 2);
          if (gen !== this.gen) return 'aborted';
          await this.source.captureFrame(new AudioFrame(f, RATE, CH, FRAME));
          this.sent++;
        }
      }
      if (this.abort) return 'aborted';
      if (this.sent === 0) return 'failed';
      await this.source.waitForPlayout();
      return this.abort ? 'aborted' : 'done';
    } catch (e) { console.error('playback error:', e.message); return this.sent ? 'aborted' : 'failed'; }
    finally { dl.kill('SIGKILL'); ff.kill('SIGKILL'); if (gen === this.gen) this.ff = this.dl = null; console.log(`[${this.roomId}] end: ${item.title} (${(this.sent / 100).toFixed(0)}s fed)`); }
  }
  elapsed() { return this.offset + this.sent / 100; }
  seek(sec) { this.skip(); this.seekReq = Math.max(0, Math.floor(sec)); }
  snapshot() {
    const items = [this.current, ...this.queue].filter(Boolean).map(slim);
    if (!items.length) return null;
    if (this.current) items[0].at = Math.floor(this.elapsed() / 10) * 10;
    return { t: Date.now(), items, volume: this.volume, loop: this.loop, radio: this.radio };
  }
  skip() { this.seekReq = null; this.abort = true; this.paused = false; this.ff?.kill('SIGKILL'); this.dl?.kill('SIGKILL'); this.source?.clearQueue?.(); }
  halt() { this.stopped = true; this.queue = []; this.skip(); }
  async leave() { this.halt(); await this.voice.leaveCall(this.roomId).catch(() => {}); this.room?.disconnect(); this.room = null; }
}

// ---- wiring ----
const client = createClient();
const server = client.connect({ serverUrl: URL_, apiKey: TOKEN });
server.reportPresence();
const apiCfg = { baseUrl: API_URL, bearerToken: TOKEN };
const voice = createVoiceCallAPI(apiCfg), directory = createRoomDirectoryAPI(apiCfg), roomsApi = createRoomCommandAPI(apiCfg);

const notify = (roomId, text) => server.postMessage({ roomId }, text);
// Reply in the thread; rooms with threads disabled reject that, so fall back to a plain message.
async function say(ctx, text) {
  try { await ctx.reply(text); }
  catch { try { await notify(ctx.message.roomId, text); } catch (e2) { console.error('could not answer:', e2.message); } }
}
const react = (ctx, e) => ctx.addReaction(e).catch(() => {});
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e?.message ?? e));
process.on('uncaughtException', (e) => console.error('uncaught exception:', e?.message ?? e));
let shuttingDown = false;
async function shutdown() {
  persistResume(); shuttingDown = true; await Promise.allSettled([...players.values()].map((p) => p.leave())); client.close(); process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

// join every channel room the bot may join, so new rooms need no manual step
const joinFailed = new Set();
async function autoJoin() {
  try {
    const rooms = await directory.listRooms(0);
    for (const r of rooms) {
      if (r.kind !== RoomKind.CHANNEL || r.archived || r.isMember) continue;
      try { await roomsApi.joinRoom(r.id); joinFailed.delete(r.id); console.log('auto-joined room', r.name); }
      catch (e) { if (!joinFailed.has(r.id)) { joinFailed.add(r.id); console.error(`cannot auto-join ${r.name}: ${e.message}`); } }
    }
  } catch (e) { console.error('auto-join check failed:', e.message); }
}
autoJoin(); setInterval(autoJoin, CFG.AUTOJOIN_MS);

// restart (docker brings us back) when the Chatto connection stays broken
let notReadySince = null;
setInterval(() => { if (notReadySince && Date.now() - notReadySince > 180_000) { console.error('connection lost for 3 min, exiting'); process.exit(1); } }, 30_000);

const HELP = [
  '## 🎵 Music bot',
  'Mention me with a command. You need to be in the call.',
  '',
  table(['Command', 'What it does'], [
    ['`play <url or search>`', 'Play or queue a song. Searches prefer studio versions; add “live”, “remix”… to ask for those'],
    ['`playlist <url>` · `search <terms>` · `pick <n>`', 'Queue a whole playlist, or browse results and choose one'],
    ['`pause` · `resume` · `skip` · `stop`', 'Playback control (3+ listeners: skip is a vote)'],
    ['`nowplaying` · `queue` · `history`', 'See what is going on'],
    ['`playnext <song>` · `skipto <n>` · `move <from> <to>`', 'Play a song right after this one, jump ahead, reorder'],
    ['`seek 1:30` · `seek +30` · `restart`', 'Jump within the current track'],
    ['`shuffle` · `remove <n>` · `clear` · `replay [n]`', 'Manage the queue'],
    ['`loop off/track/queue` · `volume <0-100>` · `radio on/off`', 'Playback modes'],
    ['`save <name>` · `load <name>` · `lists` · `delete <name>`', 'Saved queues'],
    ['`fav` · `favs` · `playfavs`', 'Your personal favorites'],
  ]),
].join('\n');

// ---- survive restarts: snapshot the queues, pick them up again on the next start ----
let lastSnap = '';
function persistResume() {
  if (shuttingDown) return;
  const r = {}; for (const [id, p] of players) { const sn = p.snapshot(); if (sn) r[id] = sn; }
  const j = JSON.stringify(Object.values(r).map(({ t, ...x }) => x));
  if (j === lastSnap) return;
  lastSnap = j; state.resume = r; save();
}
setInterval(persistResume, 10_000);
async function resumeAll() {
  const saved = state.resume ?? {}; state.resume = {}; save(); // consumed up front, so a crash while resuming cannot loop
  for (const [roomId, sn] of Object.entries(saved)) {
    if (!sn?.items?.length || Date.now() - sn.t > 15 * 60_000) continue;
    try {
      const p = new Player(roomId, voice, notify); players.set(roomId, p);
      await p.connect();
      Object.assign(p, { volume: sn.volume ?? p.volume, loop: sn.loop ?? 'off', radio: !!sn.radio });
      p.add(sn.items); console.log(`[${roomId}] resumed ${sn.items.length} tracks`);
      notify(roomId, '🔄 Back online, picking up where I left off.').catch(() => {});
    } catch (e) { players.delete(roomId); console.error(`could not resume ${roomId}: ${e.message}`); }
  }
}
setTimeout(resumeAll, 5000);

// ---- healthcheck: touch a file while the Chatto connection is up (see HEALTHCHECK in the Dockerfile) ----
const beat = () => { if (!notReadySince) try { fs.writeFileSync(CFG.HEALTH_FILE, String(Date.now())); } catch {} };
beat(); setInterval(beat, 15_000);

const seen = new Set();
console.log('music bot starting');
await server.run(async (ctx) => {
  if (seen.has(ctx.message.id)) return;
  seen.add(ctx.message.id); if (seen.size > 500) seen.delete(seen.values().next().value);
  const text = ctx.message.body.replace(/@\S+/g, '').trim();
  console.log(`cmd [${ctx.message.roomId}] ${text.slice(0, 120)}`);
  const [cmd0, ...rest] = text.split(/\s+/); const arg = rest.join(' ').trim();
  const cmd = (cmd0 || '').toLowerCase();
  const roomId = ctx.message.roomId, who = ctx.message.authorId;
  let p = players.get(roomId);
  const ensure = async () => { if (!p) players.set(roomId, (p = new Player(roomId, voice, notify))); await p.connect(); return p; };
  const room = (n) => `Queue full (max ${CFG.MAX_QUEUE}).`;
  const fits = (t) => t && t.url && (t.secs == null || t.secs <= CFG.MAX_TRACK_SEC);
  const enqueue = async (items, front = false) => {
    await ensure();
    const free = CFG.MAX_QUEUE - p.queue.length;
    if (free <= 0) return say(ctx, room());
    const ok = items.filter(fits).slice(0, free).map((t) => ({ ...t, by: who }));
    if (!ok.length) return say(ctx, `Nothing playable (tracks are limited to ${fmt(CFG.MAX_TRACK_SEC)}).`);
    const was = p.current; p.add(ok, front);
    await react(ctx, 'white_check_mark');
    const skipped = items.length - ok.length;
    if (ok.length === 1) return was ? say(ctx, `> ➕ Queued **${ok[0].title}** · ${ok[0].dur} · position ${front ? 1 : p.queue.length}`) : undefined;
    return say(ctx, `> ➕ Queued **${ok.length} tracks**${skipped ? ` · ${skipped} skipped (too long or queue full)` : ''}`);
  };
  const playerCmds = new Set(['pause', 'resume', 'skip', 'stop', 'leave', 'shuffle', 'remove', 'clear', 'loop', 'volume', 'vol', 'radio', 'replay', 'play', 'p', 'playlist', 'pick', 'load', 'playfavs', 'playnext', 'pn', 'seek', 'restart', 'skipto', 'move']);
  try {
    if (!cmd || cmd === 'help' || cmd === 'h') return void (await say(ctx, HELP));
    if (p && playerCmds.has(cmd) && !p.isListener(who)) return void (await say(ctx, 'Join the call first, then I will take your commands.'));
    await react(ctx, 'eyes');
    switch (cmd) {
      case 'play': case 'p': {
        if (!arg) return void (await say(ctx, 'Usage: `play <url or search terms>`'));
        const t = await resolveOne(arg);
        if (!t) return void (await say(ctx, 'Found nothing.'));
        return void (await enqueue([t]));
      }
      case 'playnext': case 'pn': {
        if (!arg) return void (await say(ctx, 'Usage: `playnext <url or search terms>`'));
        const t = await resolveOne(arg);
        if (!t) return void (await say(ctx, 'Found nothing.'));
        return void (await enqueue([t], true));
      }
      case 'playlist': {
        if (!/^https?:\/\//.test(arg)) return void (await say(ctx, 'Usage: `playlist <playlist url>`'));
        return void (await enqueue(await resolveMany(arg, CFG.MAX_QUEUE)));
      }
      case 'search': {
        if (!arg) return void (await say(ctx, 'Usage: `search <terms>`'));
        const res = await search(arg);
        if (!p) players.set(roomId, (p = new Player(roomId, voice, notify)));
        p.lastSearch = res;
        return void (await say(ctx, res.length ? `### 🔎 Results for “${cut(arg, 60)}”\n\n${table(['#', 'Title', 'Channel', 'Length'], res.map((r, i) => [i + 1, cut(r.title, 70), cut(r.channel ?? '', 28), r.dur]))}\n\n> Choose with \`pick <n>\`` : 'Found nothing.'));
      }
      case 'pick': {
        const t = p?.lastSearch?.[Number(arg) - 1];
        if (!t) return void (await say(ctx, 'Run `search <terms>` first, then `pick <n>`.'));
        return void (await enqueue([t]));
      }
      case 'pause': if (!p?.current) return void (await say(ctx, 'Nothing playing.')); p.paused = true; return void (await say(ctx, 'Paused.'));
      case 'resume': if (!p?.current) return void (await say(ctx, 'Nothing playing.')); p.paused = false; return void (await say(ctx, 'Resumed.'));
      case 'skip': {
        if (!p?.current) return void (await say(ctx, 'Nothing playing.'));
        const n = p.listeners;
        if (n <= 2 || p.current.by === who) { p.skip(); return void (await say(ctx, 'Skipped.')); }
        p.votes.add(who); const need = Math.floor(n / 2) + 1;
        if (p.votes.size >= need) { p.skip(); return void (await say(ctx, 'Skipped by vote.')); }
        return void (await say(ctx, `Skip vote ${p.votes.size}/${need}.`));
      }
      case 'seek': case 'restart': {
        if (!p?.current) return void (await say(ctx, 'Nothing playing.'));
        if (!p.current.secs) return void (await say(ctx, 'Cannot seek in a live stream.'));
        const t = cmd === 'restart' ? { sec: 0, relative: false } : parseTime(arg);
        if (!t) return void (await say(ctx, 'Usage: `seek 1:30` · `seek +30` · `seek -15` · `restart`'));
        const to = Math.min(Math.max(0, t.relative ? p.elapsed() + t.sec : t.sec), p.current.secs - 1);
        p.seek(to); return void (await say(ctx, `> ⏩ ${cmd === 'restart' ? 'Restarting the track' : `Jumped to **${fmt(to)}**`} / ${p.current.dur}`));
      }
      case 'skipto': {
        const r = p && skipTo(p.queue, Number(arg));
        if (!r) return void (await say(ctx, 'Usage: `skipto <queue number>`'));
        p.queue = r.queue; p.skip(); return void (await say(ctx, `> ⏭ Skipping to **${r.queue[0].title}**`));
      }
      case 'move': {
        const [a, b] = arg.split(/\s+/).map(Number);
        const r = p && move(p.queue, a, b);
        if (!r) return void (await say(ctx, 'Usage: `move <from> <to>` (queue numbers)'));
        p.queue = r.queue; return void (await say(ctx, `> ↕️ Moved **${r.track.title}** to position ${b}`));
      }
      case 'stop': case 'leave': if (!p) return void (await say(ctx, 'Not in a call.')); await p.leave(); players.delete(roomId); return void (await say(ctx, 'Bye!'));
      case 'queue': case 'q': {
        if (!p?.current && !p?.queue.length) return void (await say(ctx, 'Queue is empty.'));
        const total = p.queue.reduce((a, q) => a + (q.secs ?? 0), 0);
        const out = ['### 🎶 Queue', p.current ? `> ▶️ **Now:** ${p.current.title} · ${p.current.dur}` : null];
        if (p.queue.length) out.push('', table(['#', 'Title', 'Length'], p.queue.slice(0, 15).map((q, i) => [i + 1, cut(q.title, 70), q.dur])));
        out.push('', `${p.queue.length} up next${total ? ` · ${fmt(total)} total` : ''}${p.queue.length > 15 ? ` · showing the first 15` : ''}`);
        return void (await say(ctx, out.filter((x) => x !== null).join('\n')));
      }
      case 'nowplaying': case 'np': {
        if (!p?.current) return void (await say(ctx, 'Nothing playing.'));
        return void (await say(ctx, card(p.current, { elapsed: p.elapsed(), volume: p.volume, loop: p.loop, radio: p.radio, paused: p.paused, queued: p.queue.length })));
      }
      case 'volume': case 'vol': {
        if (!p) return void (await say(ctx, 'Not in a call.'));
        if (arg === '') return void (await say(ctx, `Volume is ${p.volume}%.`));
        const v = Number(arg); if (!Number.isFinite(v) || v < 0 || v > 100) return void (await say(ctx, 'Usage: `volume <0-100>`'));
        p.volume = Math.round(v); state.volumes[roomId] = p.volume; save(); return void (await say(ctx, `Volume ${p.volume}%.`));
      }
      case 'loop': {
        if (!p) return void (await say(ctx, 'Not in a call.'));
        if (!['off', 'track', 'queue'].includes(arg)) return void (await say(ctx, `Loop is ${p.loop}. Usage: \`loop off|track|queue\``));
        p.loop = arg; return void (await say(ctx, `Loop ${arg}.`));
      }
      case 'shuffle': {
        if (!p?.queue.length) return void (await say(ctx, 'Queue is empty.'));
        p.queue = shuffled(p.queue);
        return void (await say(ctx, 'Shuffled.'));
      }
      case 'remove': {
        const i = Number(arg) - 1; if (!p || !Number.isInteger(i) || i < 0 || i >= p.queue.length) return void (await say(ctx, 'Usage: `remove <queue number>`'));
        const [t] = p.queue.splice(i, 1); return void (await say(ctx, `Removed **${t.title}**.`));
      }
      case 'clear': if (!p) return void (await say(ctx, 'Not in a call.')); p.queue = []; return void (await say(ctx, 'Queue cleared.'));
      case 'history': case 'hist': {
        const h = p?.history.slice(-10).reverse() ?? [];
        if (!h.length && !p?.current) return void (await say(ctx, 'Nothing played yet.'));
        return void (await say(ctx, ['### 🕘 History', p?.current ? `> ▶️ **Now:** ${p.current.title}` : null, h.length ? '\n' + table(['#', 'Title', 'Length'], h.map((t, i) => [i + 1, cut(t.title, 70), t.dur])) + '\n\n> Queue one again with `replay <n>`' : null].filter(Boolean).join('\n')));
      }
      case 'replay': {
        const h = p?.history.slice().reverse(); const t = h?.[arg ? Number(arg) - 1 : 0];
        if (!t) return void (await say(ctx, 'Nothing to replay.'));
        return void (await enqueue([t]));
      }
      case 'radio': {
        if (!p) return void (await say(ctx, 'Not in a call.'));
        if (!['on', 'off'].includes(arg)) return void (await say(ctx, `Radio is ${p.radio ? 'on' : 'off'}. Usage: \`radio on|off\``));
        p.radio = arg === 'on'; if (p.radio && !p.current) p.run();
        return void (await say(ctx, p.radio ? 'Radio on: I keep playing similar songs when the queue runs out.' : 'Radio off.'));
      }
      case 'save': {
        const name = arg.toLowerCase(); if (!/^[a-z0-9_-]{1,32}$/.test(name)) return void (await say(ctx, 'Usage: `save <name>` (letters, digits, - and _)'));
        const items = [p?.current, ...(p?.queue ?? [])].filter(Boolean).map(slim);
        if (!items.length) return void (await say(ctx, 'Nothing to save.'));
        state.lists[name] = items; save(); return void (await say(ctx, `Saved ${items.length} tracks as **${name}**.`));
      }
      case 'load': {
        const l = state.lists[arg.toLowerCase()]; if (!l) return void (await say(ctx, 'No such list. See `lists`.'));
        return void (await enqueue(l));
      }
      case 'lists': {
        const names = Object.entries(state.lists); if (!names.length) return void (await say(ctx, 'No saved lists. Use `save <name>`.'));
        return void (await say(ctx, `### 💾 Saved lists\n\n${table(['Name', 'Tracks'], names.map(([n, l]) => [`\`${n}\``, l.length]))}\n\n> Load one with \`load <name>\``));
      }
      case 'delete': {
        const n = arg.toLowerCase(); if (!state.lists[n]) return void (await say(ctx, 'No such list.'));
        delete state.lists[n]; save(); return void (await say(ctx, `Deleted **${n}**.`));
      }
      case 'fav': {
        if (!p?.current) return void (await say(ctx, 'Nothing playing.'));
        const f = (state.favs[who] ??= []); if (f.some((t) => t.id === p.current.id)) return void (await say(ctx, 'Already in your favorites.'));
        if (f.length >= 100) return void (await say(ctx, 'Favorites are full (100).'));
        f.push(slim(p.current)); save(); return void (await say(ctx, `Added **${p.current.title}** to your favorites.`));
      }
      case 'favs': {
        const f = state.favs[who] ?? []; if (!f.length) return void (await say(ctx, 'No favorites yet. Use `fav` while a song plays.'));
        return void (await say(ctx, `### ⭐ Your favorites\n\n${table(['#', 'Title', 'Length'], f.slice(0, 25).map((t, i) => [i + 1, cut(t.title, 70), t.dur]))}${f.length > 25 ? `\n\n…and ${f.length - 25} more` : ''}\n\n> Queue them all with \`playfavs\``));
      }
      case 'playfavs': {
        const f = state.favs[who] ?? []; if (!f.length) return void (await say(ctx, 'No favorites yet.'));
        return void (await enqueue(f));
      }
      default: return void (await say(ctx, HELP));
    }
  } catch (e) {
    console.error('command failed:', e?.message ?? e);
    await react(ctx, 'x');
    await say(ctx, `Error: ${String(e?.message ?? e).split('\n')[0].slice(0, 300)}`);
  }
}, {
  reasons: ['mention', 'direct_message'],
  onStatus: (s) => { notReadySince = s.state === 'ready' ? null : (notReadySince ?? Date.now()); },
  onError: (e) => console.error('handler error:', e),
});
