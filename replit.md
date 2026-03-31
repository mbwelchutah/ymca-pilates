# YMCA Pilates Registration

A Node.js web app that automates registration for a Core Pilates class at the Eugene YMCA via the Daxko system.

## Architecture

- **`src/web/server.js`**: Web server entry point. Serves a simple UI and exposes a `/register` endpoint that triggers Playwright automation.
- **`src/bot/register-pilates.js`**: Standalone CLI bot run by GitHub Actions. Supports `DRY_RUN=1` for a visible-browser test without clicking Register.

## Tech Stack

- **Runtime**: Node.js 20
- **Browser Automation**: Playwright (Chromium)
- **Web Server**: Native Node.js `http` module
- **Port**: 5000 (bound to 0.0.0.0)

## Environment Variables

- `YMCA_EMAIL`: YMCA account email address
- `YMCA_PASSWORD`: YMCA account password

## Running

```bash
npm start
```

The server runs on port 5000 and serves the registration UI.
