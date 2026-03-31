# YMCA Pilates Registration

A Node.js web app that automates registration for a Core Pilates class at the Eugene YMCA via the Daxko system.

## Architecture

- **`server.js`**: Main entry point. Serves a simple web UI and exposes a `/register` endpoint that triggers Playwright automation.
- **`register-pilates.js`**: Standalone CLI version of the registration script with a dry-run mode.

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
