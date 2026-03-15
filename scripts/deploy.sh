#!/bin/bash
# STAR MERLION — VPS Deployment Script
# Run on Hostinger VPS (Ubuntu 24.04)

set -e

echo "=== STAR MERLION DEPLOYMENT ==="

# Pull latest code
cd /opt/star-merlion
git pull origin main

# Install dependencies
npm install --production
# Load NEXT_PUBLIC_* vars for Next.js build (must be in env at build time)
export $(grep '^NEXT_PUBLIC_' .env | xargs)
cd frontend && npm install --production && npm run build && cd ..

# Initialize database and vault
node scripts/init-db.js
node scripts/init-vault.js

# Restart PM2 processes
pm2 reload ecosystem.config.js

# Verify health
sleep 3
curl -s http://localhost:3001/api/health | node -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log('Health:', data.status);
  console.log('SQLite:', data.services.sqlite ? 'OK' : 'FAIL');
  console.log('Vault:', data.services.vault ? 'OK' : 'FAIL');
  if (data.status !== 'ok') process.exit(1);
"

echo "=== DEPLOYMENT COMPLETE ==="
