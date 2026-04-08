#!/bin/bash

# ==============================================================================
# ATUBE - Script d'installation et de lancement
# Ce script doit être exécuté avec des droits root ou sudo sur Debian 12.
# ==============================================================================

echo "========================================="
echo "       Initialisation de ATUBE...        "
echo "========================================="

# 1. Mise à jour des paquets
echo "[1/6] Mise à jour des paquets système..."
apt-get update -y

# 2. Installation des prérequis système
# ffmpeg pour la vidéo, curl/wget pour les téléchargements, python3 pour yt-dlp
echo "[2/6] Installation des dépendances système..."
apt-get install -y ffmpeg curl wget python3

# 3. Installation / Mise à jour de yt-dlp
# Il est crucial d'avoir la dernière version de yt-dlp pour esquiver les blocages de YouTube
echo "[3/6] Installation de yt-dlp (Dernière version)..."
wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp

# 4. Vérification et installation de Node.js (version 20)
if ! command -v node &> /dev/null || [[ $(node -v) != v20* ]]; then
    echo "[4/6] Installation de Node.js 20.x..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
else
    echo "[4/6] Node.js est déjà installé ($(node -v))."
fi

# 5. Initialisation du projet Node.js et des dépendances
echo "[5/6] Configuration du projet Node.js..."
if [ ! -f package.json ]; then
    npm init -y > /dev/null
fi

echo "Installation des dépendances NPM (yt-search, fluent-ffmpeg)..."
# On nettoie l'ancienne dépendance si elle est toujours là
npm uninstall @distube/ytdl-core 2>/dev/null
# On installe seulement ce dont on a besoin maintenant
npm install yt-search fluent-ffmpeg

# 6. Lancement du serveur
echo "[6/6] Lancement du serveur ATUBE..."
node atube.js
