#!/bin/bash
# STAR MERLION — Initial VPS Setup Script
# Target: Hostinger VPS (Ubuntu 24.04)

set -e

echo "=== STAR MERLION VPS SETUP ==="

# ── System updates ────────────────────────────────────────
echo "[1/8] Updating system packages..."
apt-get update && apt-get upgrade -y

# ── Node.js 20 ───────────────────────────────────────────
echo "[2/8] Installing Node.js 20..."
if ! command -v node &>/dev/null || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "Node.js: $(node -v)"
echo "npm: $(npm -v)"

# ── SQLite3 ──────────────────────────────────────────────
echo "[3/8] Installing SQLite3..."
apt-get install -y sqlite3 libsqlite3-dev

# ── Nginx ────────────────────────────────────────────────
echo "[4/8] Installing Nginx..."
apt-get install -y nginx
systemctl enable nginx

# ── Certbot (SSL) ────────────────────────────────────────
echo "[5/8] Installing Certbot..."
apt-get install -y certbot python3-certbot-nginx

# ── PM2 (process manager) ────────────────────────────────
echo "[6/8] Installing PM2..."
npm install -g pm2
pm2 startup systemd -u root --hp /root

# ── UFW Firewall ─────────────────────────────────────────
echo "[7/8] Configuring firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp     # SSH
ufw allow 2222/tcp   # Alternate SSH
ufw allow 80/tcp     # HTTP (redirect to HTTPS)
ufw allow 443/tcp    # HTTPS
ufw --force enable
echo "Firewall rules:"
ufw status verbose

# ── Application directories ──────────────────────────────
echo "[8/8] Creating application directories..."
mkdir -p /opt/star-merlion
mkdir -p /data/star-merlion
mkdir -p /vault/star-merlion

# Set ownership (assumes deploy user or root)
chown -R root:root /app /data /vault
chmod -R 755 /app
chmod -R 700 /data /vault

# ── SSL Certificate ──────────────────────────────────────
echo ""
echo "To obtain SSL certificate, run:"
echo "  certbot --nginx -d singaspectre.io"
echo ""

# ── Nginx config ─────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/nginx.conf" ]; then
  cp "$SCRIPT_DIR/nginx.conf" /etc/nginx/sites-available/singaspectre.io
  ln -sf /etc/nginx/sites-available/singaspectre.io /etc/nginx/sites-enabled/singaspectre.io
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
  echo "Nginx configured and reloaded."
else
  echo "Warning: nginx.conf not found at $SCRIPT_DIR/nginx.conf — skipping Nginx config."
fi

echo ""
echo "=== VPS SETUP COMPLETE ==="
echo ""
echo "Next steps:"
echo "  1. Clone the repo to /opt/star-merlion"
echo "  2. Copy .env to /opt/star-merlion/.env"
echo "  3. Run: certbot --nginx -d singaspectre.io"
echo "  4. Run: bash /opt/star-merlion/scripts/deploy.sh"
