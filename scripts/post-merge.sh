#!/bin/bash
set -e

echo "[post-merge] Installing root dependencies..."
npm install --prefer-offline

echo "[post-merge] Installing client dependencies..."
cd client && npm install --prefer-offline && cd ..

echo "[post-merge] Done."
