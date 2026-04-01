#!/bin/bash
echo "Installing Playwright system dependencies..."
npx playwright install --with-deps chromium
echo "Starting server..."
node src/web/server.js
