# Server

Run these commands from `server/`:

```sh
npm ci
npm run dev
```

Copy `.env.example` to `.env` and fill in the Supabase credentials and frontend
URL before starting. The server resolves `.env` from this folder regardless of
the current working directory. Both game settings must be integers from 5 to 99.
The HTTP server listens on `127.0.0.1` using `PORT` (default: `3000`).

## Code layout

- `server.js` connects the HTTP server, Socket.IO, and the game store.
- `lib/config.js` loads and validates environment settings.
- `lib/supabase.js` creates the server's Supabase client.
- `lib/game-settings.js` validates game settings for startup and socket requests.
- `db/game-store.js` persists multiplayer lobbies and keeps game snapshots in memory.
- `db/question-bank.js` loads and validates questions.
- `socket/index.socket.js` handles authentication, membership, chat, and requests.
- `socket/game-session.js` owns match timers, answers, scores, and private updates.
- `routes/api.routes.js` preserves the retired signup URL. Supabase owns authentication.

Membership changes are serialized to keep database writes consistent. Answer
submissions run immediately so unrelated database requests cannot delay them.
Solo matches and live match progress stay in memory. A restarted server restores
persisted multiplayer membership, but cannot resume an interrupted match.

## Checks

- `npm test`: server unit and socket integration tests; no client install or live database required.
- `npm run test:client`: optional client integration checks; requires the sibling client's source and dependencies.
- `npm run check:questions`: read-only validation of the configured Supabase question bank.
