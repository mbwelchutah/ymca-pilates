# ymca-pilates

Automates registration for the Wednesday 7:45 AM Core Pilates class (Stephanie Sanders) at the Eugene YMCA.

## How it works

| Piece | File | How it runs |
|---|---|---|
| **Booking bot** | `src/bot/register-pilates.js` | GitHub Actions every Sunday at 2:45 PM UTC |
| **Web app** | `src/web/server.js` | Replit (`npm start`) — one-button UI at port 5000 |

## Replit startup

Replit runs `npm start`, which executes `node src/web/server.js`. The app binds to `0.0.0.0:5000` and is proxied to port 80.

## GitHub Actions bot

The workflow (`.github/workflows/register-pilates.yml`) runs every Sunday and calls `node src/bot/register-pilates.js`. Requires two repository secrets: `YMCA_EMAIL` and `YMCA_PASSWORD`.

## Local dry run (visible browser)

```bash
DRY_RUN=1 YMCA_EMAIL=you@example.com YMCA_PASSWORD=secret node src/bot/register-pilates.js
```

## Environment variables

| Variable | Description |
|---|---|
| `YMCA_EMAIL` | YMCA account email |
| `YMCA_PASSWORD` | YMCA account password |
