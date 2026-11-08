import test from 'node:test';
import assert from 'node:assert/strict';
import { bestMatch, parseTime, fmt, cut, table, card, move, skipTo, shuffled, has } from '../lib.mjs';

const row = (title, extra = {}) => ({ title, secs: 200, channel: 'Someone', ...extra });

test('bestMatch prefers the studio version over live and cover uploads', () => {
  const rows = [row('Song (Live at Wembley)'), row('Song (Official Audio)'), row('Song cover by x')];
  assert.equal(bestMatch('song', rows).title, 'Song (Official Audio)');
});
test('bestMatch allows live versions when asked for', () => {
  const rows = [row('Song (Official Audio)'), row('Song (Live at Wembley)')];
  assert.equal(bestMatch('song live', rows).title, 'Song (Live at Wembley)');
});
test('bestMatch avoids live streams and overlong tracks', () => {
  const rows = [row('Song 24/7', { secs: null }), row('Song 10h', { secs: 36000 }), row('Song')];
  assert.equal(bestMatch('song', rows).title, 'Song');
});
test('bestMatch likes auto-generated Topic channels', () => {
  const rows = [row('Song', { channel: 'Fan' }), row('Song', { channel: 'Artist - Topic' })];
  assert.equal(bestMatch('song', rows).channel, 'Artist - Topic');
});
test('bestMatch on nothing returns undefined', () => assert.equal(bestMatch('x', []), undefined));
test('has matches whole words only', () => { assert.ok(has('a live show', 'live')); assert.ok(!has('alive', 'live')); });

test('parseTime', () => {
  assert.deepEqual(parseTime('90'), { sec: 90, relative: false });
  assert.deepEqual(parseTime('1:30'), { sec: 90, relative: false });
  assert.deepEqual(parseTime('1:02:03'), { sec: 3723, relative: false });
  assert.deepEqual(parseTime('+30'), { sec: 30, relative: true });
  assert.deepEqual(parseTime('-0:15'), { sec: -15, relative: true });
  for (const bad of ['', 'abc', '1:2:3:4', '1.5', '-', null]) assert.equal(parseTime(bad), null);
});
test('fmt', () => { assert.equal(fmt(65), '1:05'); assert.equal(fmt(null), 'live'); });
test('cut is emoji safe', () => { assert.equal(cut('ab😀cd', 4), 'ab😀…'); assert.equal(cut('abc', 5), 'abc'); });
test('table escapes pipes and newlines', () => {
  assert.equal(table(['A'], [['x|y\nz']]), '| A |\n|---|\n| x\\|y z |');
});
test('card shows progress and live tag', () => {
  const c = card({ title: 'T', secs: 100, dur: '1:40', channel: 'C' }, { elapsed: 50, queued: 2 });
  assert.match(c, /▰{8}▱{8}/); assert.match(c, /0:50 \/ 1:40/); assert.match(c, /2 up next/);
  assert.match(card({ title: 'T', secs: null }), /LIVE/);
});

test('move', () => {
  assert.deepEqual(move(['a', 'b', 'c'], 3, 1), { queue: ['c', 'a', 'b'], track: 'c' });
  assert.equal(move(['a'], 0, 1), null); assert.equal(move(['a'], 1, 2), null); assert.equal(move(['a'], 1.5, 1), null);
});
test('skipTo', () => {
  assert.deepEqual(skipTo(['a', 'b', 'c'], 2), { queue: ['b', 'c'], dropped: 1 });
  assert.equal(skipTo(['a'], 2), null); assert.equal(skipTo([], 1), null);
});
test('shuffled keeps all items and does not mutate', () => {
  const q = [1, 2, 3, 4, 5]; const s = shuffled(q);
  assert.deepEqual(q, [1, 2, 3, 4, 5]); assert.deepEqual([...s].sort(), q);
});
