#!/bin/bash
# Claude-Cron Auto Update Script
# 변경사항 있을 때만 pull & restart

cd /Users/sihyun/Documents/01_Projects/dev/claude-cron

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
else
  echo "[$(date)] No updates available"
fi
