#!/bin/bash
# ATUBE - Script d'installation et de démarrage
# Debian 12 · Doit être exécuté en root
# Usage : chmod +x start.sh && sudo ./start.sh

set -euo pipefail

# ─── Variables ────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd | tr -d '\r')"
YTDLP_BIN="/usr/local/bin/yt-dlp"
YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
YTDLP_SHA_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS"
SERVICE_NAME="atube"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
TELNET_PORT=23

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
echo "[1/6] Mise à jour et installation des dépendances..."
apt-get update -y -q
apt-get install -y -q --no-install-recommends \
    ffmpeg \
    curl \
    python3 \
    iptables \
    iptables-persistent \
    netfilter-persistent
echo "      Dépendances système OK"

# ─── 2. Node.js 20 ───────────────────────────────────────────────────────────
echo "[2/6] Vérification de Node.js 20..."
if ! node --version 2>/dev/null | grep -q '^v20'; then
    echo "      Installation de Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y -q nodejs
fi
echo "      Node.js $(node --version) OK"

# ─── 3. yt-dlp avec vérification SHA256 ──────────────────────────────────────
echo "[3/6] Installation de yt-dlp..."
TMP_BIN="$(mktemp)"
TMP_SHA="$(mktemp)"

cleanup() { rm -f "$TMP_BIN" "$TMP_SHA"; }
trap cleanup EXIT

curl -fsSL "$YTDLP_URL"     -o "$TMP_BIN"
curl -fsSL "$YTDLP_SHA_URL" -o "$TMP_SHA"

EXPECTED="$(grep ' yt-dlp$' "$TMP_SHA" | awk '{print $1}')"
ACTUAL="$(sha256sum "$TMP_BIN" | awk '{print $1}')"

if [[ "$EXPECTED" != "$ACTUAL" ]]; then
    echo "Erreur : SHA256 de yt-dlp invalide. Abandon." >&2
    exit 1
fi

install -m 755 "$TMP_BIN" "$YTDLP_BIN"
echo "      yt-dlp OK"

# ─── 4. Dépendances Node.js ───────────────────────────────────────────────────
echo "[4/6] Installation des dépendances npm..."
cd "$SCRIPT_DIR"
[[ ! -f package.json ]] && npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund --save fluent-ffmpeg 2>/dev/null
echo "      fluent-ffmpeg OK"

# ─── 5. Pare-feu : ouverture du port Telnet ──────────────────────────────────
echo "[5/6] Configuration du pare-feu (port ${TELNET_PORT})..."
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q 'active'; then
    ufw allow "${TELNET_PORT}/tcp" comment 'ATUBE Telnet' >/dev/null
    echo "      Port ${TELNET_PORT} ouvert via ufw OK"
else
    if ! iptables -C INPUT -p tcp --dport "${TELNET_PORT}" -j ACCEPT 2>/dev/null; then
        iptables -I INPUT -p tcp --dport "${TELNET_PORT}" -j ACCEPT
    fi
    if command -v netfilter-persistent >/dev/null 2>&1; then
        netfilter-persistent save >/dev/null 2>&1
    else
        mkdir -p /etc/iptables
        iptables-save > /etc/iptables/rules.v4
    fi
    echo "      Port ${TELNET_PORT} ouvert via iptables (persistant) OK"
fi

# ─── 6. Service systemd ───────────────────────────────────────────────────────
echo "[6/6] Configuration du service systemd..."

if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
    systemctl stop "${SERVICE_NAME}"
fi

NODE_BIN="$(which node)"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=ATUBE - YouTube ASCII Telnet Server
After=network.target
Wants=network.target
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
Type=simple
User=root
ExecStart=${NODE_BIN} ${SCRIPT_DIR}/atube.js
WorkingDirectory=/tmp
Restart=on-failure
RestartSec=5

PrivateTmp=true
ProtectHome=false
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictRealtime=true
RestrictSUIDSGID=false
LimitNOFILE=1024

StandardOutput=journal
StandardError=journal
SyslogIdentifier=atube

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl start "${SERVICE_NAME}"

# ─── Vérification finale ──────────────────────────────────────────────────────
echo ""
echo "--- Verification ---"

# attendre quelques secondes que le service démarre réellement
for i in {1..5}; do
    if systemctl is-active --quiet "${SERVICE_NAME}"; then
        break
    fi
    sleep 1
done

if ! systemctl is-active --quiet "${SERVICE_NAME}"; then
    echo "ERREUR : Le service n'a pas demarré. Logs :"
    journalctl -u "${SERVICE_NAME}" --no-pager -n 30
    exit 1
fi
echo "Service ATUBE actif OK"

if ! ss -tlnp | grep -q ":${TELNET_PORT}"; then
    echo "ERREUR : Le port ${TELNET_PORT} n'est pas en ecoute. Logs :"
    journalctl -u "${SERVICE_NAME}" --no-pager -n 30
    exit 1
fi
echo "Port ${TELNET_PORT} en ecoute OK"

echo ""
echo "============================================="
echo " ATUBE operationnel sur le port ${TELNET_PORT}"
echo "============================================="
echo ""
echo " Statut : systemctl status ${SERVICE_NAME}"
echo " Logs   : journalctl -u ${SERVICE_NAME} -f"
echo " Arret  : systemctl stop ${SERVICE_NAME}"
echo ""
echo " Si le port reste inaccessible depuis l'exterieur :"
echo " Verifiez le pare-feu Proxmox (Datacenter > Firewall)"
echo " et autorisez le port ${TELNET_PORT}/tcp au niveau CT/noeud."
echo ""
