# Contributing

Issues and pull requests are welcome.

```bash
npm ci
cp .env.example .env   # fill in a bot token for a test server
node --env-file=.env bot.mjs
```

- Requires Node.js 22+, `ffmpeg` and `yt-dlp` on your `PATH`.
- `npm run check` must pass (syntax check). CI also builds the Docker image.
- Never commit `.env` or tokens. If you paste logs in an issue, remove tokens and private URLs first.
- Chatto 0.5 is a pre-release and its client API can change. The `@chatto/client` version is pinned in `package-lock.json`.
