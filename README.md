# 🎵 chatto-music-bot

[![CI](https://github.com/fabianloebel/chatto-music-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/fabianloebel/chatto-music-bot/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

A music bot for [Chatto](https://github.com/chattocorp/chatto) voice calls. Mention it in a room, and it joins that room's
call and plays audio from YouTube (anything [yt-dlp](https://github.com/yt-dlp/yt-dlp) supports) with a queue, volume,
loop, radio mode, saved playlists and more. It works with Chatto's end-to-end encrypted calls.

> **Status:** hobby project built against Chatto `0.5.0-rc.5` (a pre-release). The Chatto client API can still change.

## Features

- 🎧 Plays into the call of the room where you wrote the command, one player per room
- 🔎 Smart search: prefers studio versions over live, cover, remix, nightcore… uploads (ask for them by naming them)
- 📃 Queue, playlists (`playlist <url>`), search results with `pick`, `playnext`, `skipto`, `move`, shuffle, remove, clear
- ⏩ `seek 1:30` / `seek +30` / `restart` inside the current track
- 🔁 Loop a track or the whole queue, 📻 radio mode keeps playing similar songs, 🕘 history and `replay`
- ⏸ Pause/resume, 🔊 volume, ⏭ skip with a majority vote when 3+ people listen
- 🔊 Stereo audio, loudness normalization between tracks, volume remembered per room
- 🔄 Picks the queue up again after a restart or redeploy (including the position in the current track)
- 💾 Saved queues and ⭐ per-user favorites, stored in a small JSON file
- 🚪 Joins new rooms automatically, leaves when everyone left or after being idle
- 🔒 Only people in the call can control playback; per-track length and queue limits
- 🩹 Self-healing: updates yt-dlp on every start, restarts after repeated failures or a lost connection

## Commands

Mention the bot, then the command, for example `@MusicBot play daft punk one more time`.
`@MusicBot help` shows the list in chat.

| Command | What it does |
|---|---|
| `play <url or search>` | Play or queue a song |
| `playlist <url>` | Queue a whole playlist (up to the queue limit) |
| `search <terms>` / `pick <n>` | Show 5 results, then queue one |
| `pause` / `resume` / `skip` / `stop` | Playback control. `stop` clears the queue and leaves the call |
| `nowplaying` / `queue` / `history` | Show what is going on |
| `playnext <song>` | Queue a song right after the current one |
| `skipto <n>` / `move <from> <to>` | Jump ahead in the queue, reorder it |
| `seek <time>` / `restart` | Jump within the track: `seek 1:30`, `seek +30`, `seek -15` |
| `shuffle` / `remove <n>` / `clear` / `replay [n]` | Manage the queue |
| `loop off\|track\|queue` / `volume <0-100>` / `radio on\|off` | Playback modes |
| `save <name>` / `load <name>` / `lists` / `delete <name>` | Saved queues (shared per server) |
| `fav` / `favs` / `playfavs` | Your own favorite songs |

A call has to be running in the room before the bot can join it.

## Setup

### 1. Create the bot in Chatto

1. **Server Admin → Bots → Create bot.** Give it a login and display name.
2. Create an **API key** for it and keep it secret. This is `CHATTO_BOT_TOKEN`.
3. Give the bot these permissions in the bot's permission matrix (the server column covers all current and future rooms):

   | Permission | Why |
   |---|---|
   | `message.read-interactions` | see messages that mention it |
   | `message.post`, `message.react` | answer and react |
   | `call.join`, `call.start`, `call.voice` | join calls and publish audio |
   | `room.list`, `room.join` | optional: lets it join new rooms by itself |

   Bots have **no** permissions by default and can never exceed their owner's. A yellow lock in the matrix means the
   owner lacks that permission at that scope. Also add the bot to your rooms with the **Joined** row (or let auto-join do it).

### 2. Run it

Requirements: Node.js 22+ (the image uses the current LTS), `ffmpeg` and `yt-dlp` on the `PATH`, or just use Docker.

```bash
cp .env.example .env     # fill in CHATTO_BOT_TOKEN, CHATTO_URL, LIVEKIT_URL
npm ci
npm start                # runs: node --env-file=.env bot.mjs
npm test                 # unit tests (node:test)
```

With Docker:

```bash
cp .env.example .env
docker compose up -d --build
```

The image bundles ffmpeg and yt-dlp, updates yt-dlp at every start and keeps saved queues in the `bot_data` volume.

### Deploying with Dokploy

Create a **Compose** service with source **Git**: repository URL of this project (or your fork), branch `main`, compose
path `./compose.yml`. Set `CHATTO_BOT_TOKEN`, `CHATTO_URL` and `LIVEKIT_URL` in the **Environment** tab (Dokploy writes them
to the `.env` file that `compose.yml` reads). Deploy. To update, press **Deploy** again: it pulls the latest commit and
rebuilds. No ports or domains are needed, the bot only makes outbound connections (Chatto API, and WebRTC to your LiveKit).

## Configuration

Required: `CHATTO_BOT_TOKEN`, `CHATTO_URL`, `LIVEKIT_URL`. Optional settings, all with defaults:

| Variable | Default | Meaning |
|---|---|---|
| `ALONE_GRACE_MS` | `20000` | leave the call this long after the last human left |
| `IDLE_MS` | `300000` | leave after this long with nothing playing |
| `MAX_TRACK_SEC` | `1800` | reject longer tracks (live streams are allowed) |
| `MAX_QUEUE` | `50` | maximum queue length per room |
| `REQUIRE_LISTENER` | `true` | only people in the call may control playback |
| `SMART_SEARCH` | `true` | prefer studio versions in text searches |
| `NORMALIZE` | `true` | even out loudness between tracks (ffmpeg `loudnorm`) |
| `STEREO` | `true` | publish stereo audio; `false` sends mono |
| `HEALTH_FILE` | `/tmp/healthy` | file touched while connected, read by the Docker `HEALTHCHECK` |
| `AUTOJOIN_MS` | `60000` | how often to look for new rooms to join |
| `DATA_FILE` | `/data/state.json` | where saved queues and favorites live |

## How it works

1. `@chatto/client` connects to the server with the bot's API key and delivers messages that mention the bot.
2. For `play`, the bot resolves the song with `yt-dlp`, then calls `JoinCall` and `CreateCallToken` to get a LiveKit token
   and the call's shared encryption key.
3. It connects with `@livekit/rtc-node` using that key (end-to-end encrypted) and publishes one microphone track.
4. Audio flows `yt-dlp → ffmpeg (48 kHz stereo PCM, loudness-normalized) → LiveKit` in 10 ms frames. Volume, pause, skip and seek act on that stream.
5. Every 10 s the queues are written to the state file, so a restart resumes them (only if a call is still running).
6. Rich replies are plain Markdown (headings, tables, quotes, emoji), since Chatto has no embeds or buttons.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Nothing happens when you mention the bot | The mention was typed, not picked from the autocomplete; the bot is not a room member; it lacks `message.read-interactions` |
| `permission_denied` / "no call token" | Start a call in the room first; grant `call.join`, `call.start`, `call.voice` |
| Replies fail in one room | Threads are disabled there. The bot falls back to plain messages automatically |
| Songs fail to load | YouTube changed something. Restart the container to pull a new yt-dlp (the bot also does this after 3 failures) |
| Hear overlapping audio | Check you picked the studio version; the bot never plays two tracks at once in a room |

## Legal note

Downloading audio from YouTube may violate its terms of service in your jurisdiction. This project is meant for private
servers and personal use. You are responsible for how you use it.

## License

[MIT](LICENSE)
