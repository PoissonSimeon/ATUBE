#!/bin/bash

# ==============================================================================
# ASCIITUBE - Script d'installation et de lancement
# Ce script doit être exécuté avec des droits root ou sudo sur Debian 12.
# ==============================================================================

echo "========================================="
echo "    Initialisation de ASCIITUBE...       "
echo "========================================="

# 1. Mise à jour des paquets
echo "[1/5] Mise à jour des paquets système..."
apt-get update -y

# 2. Installation des prérequis système (curl, ffmpeg)
echo "[2/5] Installation de FFmpeg et Curl..."
apt-get install -y ffmpeg curl

# 3. Vérification et installation de Node.js (version 20)
if ! command -v node &> /dev/null || [[ $(node -v) != v20* ]]; then
    echo "[3/5] Installation de Node.js 20.x..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
else
    echo "[3/5] Node.js est déjà installé ($(node -v))."
fi

# 4. Initialisation du projet Node.js et des dépendances
echo "[4/5] Configuration du projet Node.js..."
if [ ! -f package.json ]; then
    npm init -y > /dev/null
fi

echo "Installation des dépendances NPM (yt-search, @distube/ytdl-core, fluent-ffmpeg)..."
npm install yt-search @distube/ytdl-core fluent-ffmpeg

# 5. Lancement du serveur
echo "[5/5] Lancement du serveur ASCIITUBE..."
node ASCIITUBE.js
