#!/bin/bash
# ATUBE - Script d'installation et de démarrage simplifié
# Doit être exécuté en root

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="atube"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if [[ $EUID -ne 0 ]]; then
    echo "❌ Erreur : ce script doit être exécuté en root."
    exit 1
fi

echo "============================================="
echo "   Installation et Démarrage de ATUBE"
echo "============================================="

# 1. Nettoyage des retours à la ligne Windows (CRLF) qui font crasher Linux
echo "[1/5] Nettoyage des fichiers..."
sed -i 's/\r$//' "${SCRIPT_DIR}/atube.js" 2>/dev/null || true

# 2. Dépendances système
echo "[2/5] Installation des dépendances système..."
apt-get update -y -q > /dev/null
apt-get install -y -q ffmpeg curl wget python3 > /dev/null

# 3. Node.js
echo "[3/5] Vérification de Node.js..."
if ! command -v node >/dev/null || [[ $(node -v) != v20* ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null
    apt-get install -y -q nodejs > /dev/null
fi

# 4. yt-dlp & NPM
echo "[4/5] Installation de yt-dlp et fluent-ffmpeg..."
wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
chmod +x /usr/local/bin/yt-dlp

cd "$SCRIPT_DIR"
[[ ! -f package.json ]] && npm init -y >/dev/null 2>&1
npm install fluent-ffmpeg >/dev/null 2>&1

# 5. Service Systemd ultra-simplifié
echo "[5/5] Création du service en arrière-plan..."
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=ATUBE - YouTube ASCII Telnet Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${SCRIPT_DIR}
ExecStart=$(which node) ${SCRIPT_DIR}/atube.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# Rechargement et démarrage du service
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" > /dev/null 2>&1
systemctl restart "$SERVICE_NAME"

# Vérification finale
sleep 2
echo "============================================="
if systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "✅ SUCCÈS ! ATUBE tourne parfaitement en arrière-plan."
    echo "👉 Testez en tapant : telnet localhost 23"
else
    echo "❌ ERREUR : Le service n'a pas pu démarrer. Logs :"
    journalctl -u "$SERVICE_NAME" -n 15 --no-pager
fi
