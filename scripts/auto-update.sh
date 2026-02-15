#!/usr/bin/env bash

# Claude-Cron Auto Update Script
# 변경사항 있을 때만 pull & restart
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_DIR}"

# Git fetch
git fetch origin main 2>/dev/null

# Compare local and remote
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" != "$REMOTE" ]; then
  echo "[$(date)] Updating claude-cron..."
  git pull origin main
  npm run build
  pm2 restart claude-cron
  echo "[$(date)] Update complete!"

  if [ -f "${REPO_DIR}/config/codex-auth.json" ]; then
    mkdir -p "${HOME}/.codex"
    cp -u "${REPO_DIR}/config/codex-auth.json" "${HOME}/.codex/auth.json"
    chmod 600 "${HOME}/.codex/auth.json"
    echo "[$(date)] Synced ${HOME}/.codex/auth.json"
  else
    echo "[$(date)] No config/codex-auth.json found; skipped auth sync."
  fi
else
  echo "[$(date)] No updates available"
fi
