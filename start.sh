#!/bin/bash
# ATUBE - Script d'installation et de démarrage
# Debian 12 · Doit être exécuté en root
# Usage : chmod +x start.sh && sudo ./start.sh

set -euo pipefail

# ─── Variables ────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YTDLP_BIN="/usr/local/bin/yt-dlp"
YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
YTDLP_SHA_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS"
SERVICE_NAME="atube"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# ─── Vérifications préalables ─────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    echo "Erreur : ce script doit être exécuté en root." >&2
    exit 1
fi

if [[ ! -f "${SCRIPT_DIR}/atube.js" ]]; then
    echo "Erreur : atube.js introuvable dans ${SCRIPT_DIR}." >&2
    exit 1
fi

echo "============================================="
echo "        Installation de ATUBE"
echo "============================================="

# ─── 1. Dépendances système ───────────────────────────────────────────────────
echo "[1/5] Mise à jour et installation des dépendances..."
apt-get update -y -q
apt-get install -y -q --no-install-recommends ffmpeg curl python3

# ─── 2. Node.js 20 ───────────────────────────────────────────────────────────
echo "[2/5] Vérification de Node.js 20..."
if ! node --version 2>/dev/null | grep -q '^v20'; then
    echo "      Installation de Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y -q nodejs
fi
echo "      Node.js $(node --version) ✓"

# ─── 3. yt-dlp avec vérification SHA256 ──────────────────────────────────────
echo "[3/5] Installation de yt-dlp..."
TMP_BIN="$(mktemp)"
TMP_SHA="$(mktemp)"

cleanup() { rm -f "$TMP_BIN" "$TMP_SHA"; }
trap cleanup EXIT

curl -fsSL "$YTDLP_URL"     -o "$TMP_BIN"
curl -fsSL "$YTDLP_SHA_URL" -o "$TMP_SHA"

EXPECTED="$(grep ' yt-dlp$' "$TMP_SHA" | awk '{print $1}')"
ACTUAL="$(sha256sum "$TMP_BIN" | awk '{print $1}')"

if [[ "$EXPECTED" != "$ACTUAL" ]]; then
    echo "Erreur : SHA256 de yt-dlp invalide (intégrité compromise). Abandon." >&2
    exit 1
fi

install -m 755 "$TMP_BIN" "$YTDLP_BIN"
echo "      yt-dlp $(yt-dlp --version) installé et vérifié ✓"

# ─── 4. Dépendances Node.js ───────────────────────────────────────────────────
echo "[4/5] Installation des dépendances npm..."
cd "$SCRIPT_DIR"
[[ ! -f package.json ]] && npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund --save fluent-ffmpeg 2>/dev/null
echo "      fluent-ffmpeg installé ✓"

# ─── 5. Service systemd ───────────────────────────────────────────────────────
echo "[5/5] Configuration du service systemd..."

# Arrêter le service existant si actif
if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
    systemctl stop "${SERVICE_NAME}"
fi

NODE_BIN="$(which node)"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=ATUBE - YouTube ASCII Telnet Server
After=network.target
Wants=network.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${SCRIPT_DIR}/atube.js
WorkingDirectory=/tmp
Restart=on-failure
RestartSec=5
StartLimitBurst=5
StartLimitIntervalSec=60

# Sécurité : restreindre la surface d'attaque au niveau systemd
NoNewPrivileges=false
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/tmp
LimitNOFILE=1024

StandardOutput=journal
StandardError=journal
SyslogIdentifier=atube

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"

echo ""
echo "============================================="
echo " ATUBE démarré avec succès sur le port 23"
echo "============================================="
echo ""
echo " Statut : systemctl status ${SERVICE_NAME}"
echo " Logs   : journalctl -u ${SERVICE_NAME} -f"
echo " Arrêt  : systemctl stop ${SERVICE_NAME}"
echo ""
