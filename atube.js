const net = require('net');
const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const { PassThrough } = require('stream');

// --- Configuration ---
const PORT = 2323;
// Palette ASCII du plus sombre au plus clair
const ASCII_CHARS = [' ', '.', ':', '-', '=', '+', '*', '#', '%', '@'];
const WIDTH = 80;
const HEIGHT = 24; // Format adapté aux terminaux standards
const FRAME_SIZE = WIDTH * HEIGHT; // 1 octet par pixel (en niveaux de gris)

const server = net.createServer((socket) => {
    let state = 'SEARCH'; // États possibles : SEARCH, SELECT, PLAYING
    let searchResults = [];
    let inputBuffer = '';
    
    let currentFfmpeg = null;
    let currentVideoStream = null;

    // Fonctions utilitaires pour le terminal
    const send = (msg) => socket.write(msg);
    const clear = () => send('\x1B[2J\x1B[H'); // Efface l'écran et curseur en haut à gauche
    const resetCursor = () => send('\x1B[H');   // Curseur en haut à gauche (pour écraser sans clignoter)
    const hideCursor = () => send('\x1B[?25l'); // Cache le curseur
    const showCursor = () => send('\x1B[?25h'); // Montre le curseur

    const promptSearch = () => {
        showCursor();
        clear();
        send('================================================================================\r\n');
        send('                                *** ATUBE *** \r\n');
        send('                      YouTube directement dans ton CLI                          \r\n');
        send('================================================================================\r\n\r\n');
        send('Entrez votre recherche YouTube (ou "quit" pour quitter) : ');
        state = 'SEARCH';
    };

    promptSearch();

    socket.on('data', async (data) => {
        const str = data.toString();

        // Si l'utilisateur tape Entrée
        if (str.includes('\n') || str.includes('\r')) {
            // Sépare le texte envoyé d'un coup (Line mode) du saut de ligne
            const parts = str.split(/[\r\n]+/);
            if (parts[0]) {
                inputBuffer += parts[0];
            }

            const query = inputBuffer.trim();
            inputBuffer = ''; // Reset du buffer

            // Si la vidéo est en cours, n'importe quelle touche 'Entrée' arrête la vidéo
            if (state === 'PLAYING') {
                stopVideo();
                promptSearch();
                return;
            }

            if (query.toLowerCase() === 'quit' || query.toLowerCase() === 'exit') {
                send('\r\nAu revoir !\r\n');
                socket.end();
                return;
            }

            if (state === 'SEARCH') {
                if (!query) {
                    promptSearch();
                    return;
                }
                send('\r\n\r\nRecherche en cours pour "' + query + '"...\r\n');
                try {
                    const r = await yts(query);
                    searchResults = r.videos.slice(0, 5); // Garder les 5 premiers résultats
                    
                    clear();
                    send('Résultats pour : ' + query + '\r\n\r\n');
                    searchResults.forEach((v, i) => {
                        send(`[${i + 1}] ${v.title} (${v.timestamp})\r\n`);
                    });
                    send('\r\n[0] Nouvelle recherche\r\n');
                    send('\r\nChoisissez un numéro : ');
                    state = 'SELECT';
                } catch (e) {
                    send('\r\nErreur lors de la recherche. Appuyez sur Entrée pour réessayer.\r\n');
                    state = 'SEARCH';
                }
            } else if (state === 'SELECT') {
                const choice = parseInt(query);
                if (choice === 0) {
                    promptSearch();
                } else if (choice > 0 && choice <= searchResults.length) {
                    playVideo(searchResults[choice - 1].url);
                } else {
                    send('\r\nChoix invalide. Choisissez un numéro (0-5) : ');
                }
            }
        } else {
            // Gestion de la saisie (Echo local + Retour arrière)
            if (data[0] === 0x08 || data[0] === 0x7f) { // Touche Backspace
                if (inputBuffer.length > 0) {
                    inputBuffer = inputBuffer.slice(0, -1);
                    send('\b \b'); // Effacement visuel dans le terminal
                }
            } else {
                inputBuffer += str;
                send(str); // Echo du caractère tapé
            }
        }
    });

    const stopVideo = () => {
        if (currentFfmpeg) {
            currentFfmpeg.kill('SIGKILL');
            currentFfmpeg = null;
        }
        if (currentVideoStream) {
            currentVideoStream.destroy();
            currentVideoStream = null;
        }
    };

    const playVideo = (url) => {
        state = 'PLAYING';
        clear();
        hideCursor();
        send('Mise en cache du flux (Appuyez sur Entrée pour arrêter)...\r\n');

        try {
            // Utilisation du filtre 'audioandvideo' qui cible le format MP4 classique 360p.
            // C'est le format "historique" de YouTube, souvent le seul qui ne plante pas
            // face aux restrictions ou qui reste disponible sur toutes les vidéos.
            currentVideoStream = ytdl(url, { 
                filter: 'audioandvideo'
            });

            // Écouteur d'erreur spécifique pour le flux YouTube (ex: blocage par YouTube)
            currentVideoStream.on('error', (err) => {
                if (state === 'PLAYING') {
                    send(`\r\nErreur de flux YouTube : ${err.message}\r\nAppuyez sur Entrée pour revenir au menu.\r\n`);
                    stopVideo();
                }
            });

            const imageStream = new PassThrough();

            // Configuration de FFmpeg pour cracher des images brutes (rawvideo) en nuances de gris
            currentFfmpeg = ffmpeg(currentVideoStream)
                .fps(15) // 15 images par secondes (fluide mais pas trop lourd en ASCII)
                .size(`${WIDTH}x${HEIGHT}`)
                .format('image2pipe')
                .videoCodec('rawvideo')
                .outputOptions('-pix_fmt gray') // Niveaux de gris (1 octet = 1 pixel)
                .on('error', (err) => {
                    // On ignore les erreurs de type "SIGKILL" qui arrivent quand on quitte la vidéo manuellement
                    if (!err.message.includes('SIGKILL') && state === 'PLAYING') {
                        send(`\r\nErreur FFmpeg: ${err.message}\r\nAppuyez sur Entrée pour revenir au menu.\r\n`);
                    }
                });

            currentFfmpeg.pipe(imageStream);

            let frameBuffer = Buffer.alloc(0);

            imageStream.on('data', (chunk) => {
                frameBuffer = Buffer.concat([frameBuffer, chunk]);

                // Dès qu'on a assez de données pour faire une image complète (80x24)
                while (frameBuffer.length >= FRAME_SIZE) {
                    const frameData = frameBuffer.subarray(0, FRAME_SIZE);
                    frameBuffer = frameBuffer.subarray(FRAME_SIZE);

                    let asciiFrame = '';
                    for (let y = 0; y < HEIGHT; y++) {
                        for (let x = 0; x < WIDTH; x++) {
                            const pixelVal = frameData[y * WIDTH + x];
                            // Conversion de la nuance de gris (0-255) en un caractère ASCII
                            const charIndex = Math.floor((pixelVal / 255) * (ASCII_CHARS.length - 1));
                            asciiFrame += ASCII_CHARS[charIndex];
                        }
                        asciiFrame += '\r\n'; // Fin de ligne pour le terminal
                    }
                    
                    // On place le curseur en haut à gauche et on affiche l'image par dessus l'ancienne
                    if (state === 'PLAYING') {
                        socket.write('\x1B[H' + asciiFrame);
                    }
                }
            });

        } catch (err) {
            send(`\r\nErreur de chargement de la vidéo : ${err.message}\r\nAppuyez sur Entrée.\r\n`);
        }
    };

    // Nettoyage si le client se déconnecte brusquement
    socket.on('close', stopVideo);
    socket.on('error', stopVideo);
});

server.listen(PORT, () => {
    console.log(`=============================================`);
    console.log(` Serveur ATUBE en écoute sur le port ${PORT} `);
    console.log(`=============================================`);
    console.log(`Testez-le avec la commande : telnet localhost ${PORT}`);
});
