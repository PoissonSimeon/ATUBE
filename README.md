📺 ATUBE - YouTube dans ton Terminal

ATUBE est un serveur Telnet léger écrit en Node.js permettant de rechercher et de lire des vidéos YouTube en ASCII art directement depuis n'importe quel terminal en ligne de commande (CLI), sans interface graphique, sans navigateur, et sans dépendances côté client.

✨ Fonctionnalités

Lecture ASCII Fluide : Conversion en temps réel du flux vidéo en caractères ASCII (15 FPS constant).

Auto-Redimensionnement : Utilise la négociation Telnet (NAWS) pour adapter dynamiquement la résolution vidéo à la taille exacte de votre fenêtre de terminal. Format 16:9, 4:3 ou 1:1 gérés avec centrage automatique.

Sous-titres Intégrés : Télécharge automatiquement les sous-titres (.vtt/.srt), avec priorité à la langue originale, et les affiche en temps réel sous la vidéo. Intègre un algorithme d'Anti-Rolling pour rendre les sous-titres automatiques lisibles.

Moteur de recherche paginé : Recherchez n'importe quelle vidéo, naviguez entre les pages de résultats.

Sécurité "Surblindée" (Zero-Trust) : * Drop de privilèges : Démarre en root pour capturer le port 23, puis abandonne instantanément ses droits pour tourner sous l'utilisateur inoffensif nobody.

Anti-DDoS : Limite de connexions simultanées globales et par adresse IP.

Anti-Injection : Sanitisation extrême des saisies clavier et blocage d'injections Shell.

🚀 Installation & Déploiement

Prérequis

Un serveur Linux (Testé sous Debian 12 / Ubuntu).

Droits root ou sudo pour l'installation et l'ouverture du port 23.

Lancement Rapide (Script Automatisé)

Clonez ce dépôt ou transférez les fichiers atube.js et start.sh sur votre serveur.

Rendez le script exécutable et lancez-le en tant que root :

chmod +x start.sh
sudo ./start.sh


Le script se chargera de :

Mettre à jour la machine.

Installer les dépendances (ffmpeg, yt-dlp officiel, nodejs v20).

Installer l'unique paquet NPM nécessaire (fluent-ffmpeg).

Lancer le serveur sur le port 23.

🎮 Comment l'utiliser ?

Depuis n'importe quelle machine (Windows, Mac, Linux) disposant d'un client Telnet, ouvrez votre terminal et tapez :

telnet <adresse_ip_du_serveur>
# (ou telnet atube.votre-domaine.com si vous avez configuré un DNS)


Contrôles pendant la vidéo :

Appuyez sur Entrée pour arrêter la vidéo et revenir au menu.

Faites Ctrl+C pour quitter instantanément le serveur Telnet.

⚙️ Architecture Réseau & Reverse Proxy

Si vous souhaitez héberger ATUBE derrière un nom de domaine (ex: Cloudflare), gardez en tête que le trafic Telnet (Port 23) n'est pas du HTTP.

Cloudflare : Vous devez désactiver le proxy (le "nuage orange" doit être GRIS / DNS Only).

Routeur / Box : Faites une simple redirection (Port Forwarding) du port 23 vers l'IP locale de la machine qui héberge ATUBE.

N'utilisez pas de proxy web (comme Caddy ou Nginx HTTP) pour relayer ce trafic.

🛡️ Avertissement

Le protocole Telnet est non chiffré. Les recherches saisies par les utilisateurs transitent en clair. Ne saisissez jamais d'informations personnelles sur un réseau Telnet public.
