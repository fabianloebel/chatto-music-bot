# Changelog

## 0.2.0

- New commands: `playnext`, `skipto`, `move`, `seek`, `restart`
- Queue and position survive restarts and redeploys
- Loudness normalization (`NORMALIZE=false` to disable) and stereo audio (`STEREO=false` for mono)
- Volume is remembered per room
- Search: words in the query such as "live" or "remix" now favour matching uploads
- Docker healthcheck, Node 26 (LTS) image
- Pure helpers moved to `lib.mjs`, unit tests with `npm test`, CI runs on Node 22 and 26

## 0.1.0 – initial release

- Voice playback into Chatto calls (LiveKit, end-to-end encrypted calls supported)
- Commands: `play`, `playlist`, `search`/`pick`, `pause`, `resume`, `skip` (vote), `stop`, `queue`,
  `nowplaying`, `volume`, `loop`, `shuffle`, `remove`, `clear`, `history`, `replay`, `radio`,
  `save`/`load`/`lists`/`delete`, `fav`/`favs`/`playfavs`
- Smart search that prefers studio versions over live/cover/remix uploads
- Auto-join of new rooms, auto-leave when alone or idle
- Listeners-only control, track length and queue limits
- Rich Markdown replies (headings, tables, quotes, emoji)
- Docker image, self-updating yt-dlp, self-restart on repeated failures
