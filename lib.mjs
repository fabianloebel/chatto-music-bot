// Pure helpers (no I/O, no environment access) so they can be unit-tested.

// Plain-text searches prefer the studio version: skip live/cover/remix-style uploads unless the query asks for them.
export const UNWANTED = ['live', 'concert', 'cover', 'remix', 'karaoke', 'reaction', 'tutorial', 'slowed', 'reverb', 'sped up', '8d', 'nightcore', 'instrumental', 'acoustic', 'medley', 'mashup', 'compilation', 'full album', '1 hour', '10 hours', 'playlist'];

export const has = (text, w) => new RegExp(`(^|[^a-z0-9])${w}($|[^a-z0-9])`, 'i').test(text);

export function bestMatch(query, rows, maxTrackSec = 30 * 60) {
  const q = query.toLowerCase();
  const bad = UNWANTED.filter((w) => !has(q, w));
  const score = (r) => {
    const t = r.title.toLowerCase();
    let sc = 0;
    if (/ - topic$/i.test(r.channel ?? '')) sc += 3;           // auto-generated album uploads
    if (/official (audio|music video|video)|\(audio\)|\[audio\]/.test(t)) sc += 2;
    if (r.secs == null && !has(q, 'live')) sc -= 10;             // live streams
    if (r.secs != null && r.secs > maxTrackSec) sc -= 10;
    if (bad.some((w) => has(t, w))) sc -= 8;
    sc += 4 * UNWANTED.filter((w) => has(q, w) && has(t, w)).length; // the query asked for this flavour
    return sc;
  };
  return rows.map((r, i) => ({ r, sc: score(r) - i * 0.1 })).sort((a, b) => b.sc - a.sc)[0]?.r;
}

export const fmt = (s) => (s == null ? 'live' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

// "90", "1:30", "1:02:03", "+30" / "-15" (relative) -> { sec, relative } or null
export function parseTime(text) {
  const s = String(text ?? '').trim();
  const rel = /^[+-]/.test(s);
  const body = rel ? s.slice(1) : s;
  if (!/^\d+(:\d{1,2}){0,2}$/.test(body)) return null;
  const sec = body.split(':').reduce((a, p) => a * 60 + Number(p), 0);
  return { sec: rel && s[0] === '-' ? -sec : sec, relative: rel };
}

export const cut = (t, n) => { const a = Array.from(String(t ?? '')); return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };
export const md = (t) => String(t ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
export const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(md).join(' | ')} |`)].join('\n');

export function card(track, { elapsed = 0, volume = 100, loop = 'off', radio = false, paused = false, queued = 0 } = {}) {
  const channel = track.channel && track.channel !== 'NA' ? track.channel : null;
  const bar = track.secs ? '▰'.repeat(Math.round(Math.min(1, elapsed / track.secs) * 16)).padEnd(16, '▱') : '▰'.repeat(16);
  const tags = [`🔊 ${volume}%`, loop !== 'off' ? `🔁 ${loop}` : null, radio ? '📻 radio' : null, queued ? `⏭ ${queued} up next` : null].filter(Boolean).join('  ·  ');
  return [
    `### ${paused ? '⏸ Paused' : '🎵 Now playing'}`,
    `**${cut(track.title, 90)}**${channel ? `  \n${cut(channel, 50)}` : ''}`,
    `\`${bar}\`  ${track.secs ? `${fmt(elapsed)} / ${track.dur}` : '🔴 LIVE'}`,
    `> ${tags}`,
  ].join('\n\n');
}

// Queue operations. All take and return plain arrays and never throw.
export function move(queue, from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  if (from < 1 || to < 1 || from > queue.length || to > queue.length) return null;
  const q = queue.slice(); const [t] = q.splice(from - 1, 1); q.splice(to - 1, 0, t);
  return { queue: q, track: t };
}
// "skip to position n": drop the n-1 tracks before it
export function skipTo(queue, n) {
  if (!Number.isInteger(n) || n < 1 || n > queue.length) return null;
  return { queue: queue.slice(n - 1), dropped: n - 1 };
}
export function shuffled(queue, rnd = Math.random) {
  const q = queue.slice();
  for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; }
  return q;
}
