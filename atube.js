const net = require('net');
const yts = require('yt-search');
const ffmpeg = require('fluent-ffmpeg');
const { PassThrough } = require('stream');
const { spawn } = require('child_process');

// --- Configuration Générale ---
const PORT = 2323;
const ASCII_CHARS = [' ', '.', ':', '-', '=', '+', '*', '#', '%', '@'];
const FPS = 15;
const FRAME_DELAY = 1000 / FPS;

const server = net.createServer((socket) => {
    // Dimensions par défaut, mises à jour via Telnet NAWS
    let termWidth = 80;
    let termHeight = 24;

    let state = 'SEARCH'; // SEARCH, SELECT, PLAYING
    let searchResults = [];
    let inputBuffer = '';
    
    let currentFfmpeg = null;
    let currentYtDlp = null;
    let playInterval = null;

    // Utilitaires d'affichage
    const send = (msg) => socket.write(msg);
    const clear = () => send('\x1B[2J\x1B[H');
    const hideCursor = () => send('\x1B[?25l');
    const showCursor = () => send('\x1B[?25h');

    // Demande au client Telnet de communiquer la taille de sa fenêtre (RFC 1073 - NAWS)
    socket.write(Buffer.from([255, 253, 31])); 

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

    socket.on('data', async (rawBuffer) => {
        // --- Parseur Telnet (Extraction de la commande NAWS et nettoyage des entrées) ---
        let pureData = Buffer.alloc(0);
        let i = 0;
        while (i < rawBuffer.length) {
            if (rawBuffer[i] === 255) { // Si c'est le code Telnet IAC (Interpret As Command)
                if (i + 2 < rawBuffer.length && rawBuffer[i+1] === 250 && rawBuffer[i+2] === 31) {
                    // C'est une réponse NAWS (Subnegotiation Window Size)
                    if (i + 8 < rawBuffer.length) {
                        termWidth = rawBuffer.readUInt16BE(i + 3);
                        termHeight = rawBuffer.readUInt16BE(i + 5);
                        i += 9; // On saute tout le bloc de négociation
                    } else break;
                } else if (i + 1 < rawBuffer.length && rawBuffer[i+1] >= 251 && rawBuffer[i+1] <= 254) {
                    i += 3; // Saute DO/DONT/WILL/WONT
                } else i += 2; // Saute une commande Telnet standard
            } else {
                pureData = Buffer.concat([pureData, Buffer.from([rawBuffer[i]])]);
                i++;
            }
        }

        const str = pureData.toString();
        if (!str) return; // Si la trame ne contenait que des commandes système Telnet, on s'arrête là

        // --- Logique utilisateur ---
        if (str.includes('\n') || str.includes('\r')) {
            const parts = str.split(/[\r\n]+/);
            if (parts[0]) inputBuffer += parts[0];

            const query = inputBuffer.trim();
            inputBuffer = ''; 

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
                if (!query) { promptSearch(); return; }
                send('\r\n\r\nRecherche en cours pour "' + query + '"...\r\n');
                try {
                    const r = await yts(query);
                    searchResults = r.videos.slice(0, 5);
                    
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
                    // On passe l'objet vidéo entier pour avoir accès à sa durée
                    playVideo(searchResults[choice - 1]);
                } else {
                    send('\r\nChoix invalide. Choisissez un numéro (0-5) : ');
                }
            }
        } else {
            if (pureData[0] === 0x08 || pureData[0] === 0x7f) { 
                if (inputBuffer.length > 0) {
                    inputBuffer = inputBuffer.slice(0, -1);
                    send('\b \b');
                }
            } else {
                inputBuffer += str;
                send(str);
            }
        }
    });

    const stopVideo = () => {
        if (playInterval) { clearInterval(playInterval); playInterval = null; }
        if (currentFfmpeg) { currentFfmpeg.kill('SIGKILL'); currentFfmpeg = null; }
        if (currentYtDlp) { currentYtDlp.kill('SIGKILL'); currentYtDlp = null; }
    };

    // Formatage du temps pour la barre de progression (ex: 01:25)
    const formatTime = (secs) => {
        const m = Math.floor(secs / 60).toString().padStart(2, '0');
        const s = Math.floor(secs % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    };

    const generateProgressBar = (currentSecs, totalSecs, width) => {
        const timeStr = ` ${formatTime(currentSecs)} / ${formatTime(totalSecs)} `;
        const barWidth = width - timeStr.length - 2; 
        
        if (barWidth < 5) return timeStr.padStart(width, ' '); // Si le terminal est minuscule

        const progress = totalSecs > 0 ? Math.min(currentSecs / totalSecs, 1) : 0;
        const filled = Math.floor(barWidth * progress);
        const empty = barWidth - filled;
        
        // Ex: [======>        ] 01:20 / 03:40
        return '[' + '='.repeat(filled) + '>'.repeat(empty > 0 ? 1 : 0) + ' '.repeat(Math.max(0, empty - 1)) + ']' + timeStr;
    };

    const playVideo = (videoInfo) => {
        state = 'PLAYING';
        clear();
        hideCursor();
        send('Mise en cache du flux via yt-dlp...\r\n');

        // On adapte la résolution vidéo à la taille réelle du terminal de l'utilisateur
        // On retire 1 en hauteur ET en largeur pour éviter le "retour à la ligne automatique" du terminal
        const videoWidth = Math.max(20, termWidth - 1);
        const videoHeight = Math.max(10, termHeight - 1); 
        const frameByteSize = videoWidth * videoHeight;

        let frameQueue = [];
        let framesPlayed = 0;

        try {
            currentYtDlp = spawn('yt-dlp', [
                '-f', 'worst', 
                '--quiet', '--no-warnings', '-o', '-', 
                videoInfo.url
            ]);

            currentYtDlp.stderr.on('data', (data) => {
                if (state === 'PLAYING' && data.toString().includes('ERROR:')) {
                    send(`\r\nBlocage YouTube : ${data.toString().trim()}\r\nAppuyez sur Entrée.\r\n`);
                    stopVideo();
                }
            });

            const imageStream = new PassThrough();

            currentFfmpeg = ffmpeg(currentYtDlp.stdout)
                .fps(FPS)
                .size(`${videoWidth}x${videoHeight}`)
                .format('image2pipe')
                .videoCodec('rawvideo')
                .outputOptions('-pix_fmt gray');

            currentFfmpeg.pipe(imageStream);

            let frameBuffer = Buffer.alloc(0);

            imageStream.on('data', (chunk) => {
                frameBuffer = Buffer.concat([frameBuffer, chunk]);

                while (frameBuffer.length >= frameByteSize) {
                    const frameData = frameBuffer.subarray(0, frameByteSize);
                    frameBuffer = frameBuffer.subarray(frameByteSize);

                    let asciiFrame = '';
                    for (let y = 0; y < videoHeight; y++) {
                        for (let x = 0; x < videoWidth; x++) {
                            const pixelVal = frameData[y * videoWidth + x];
                            const charIndex = Math.floor((pixelVal / 255) * (ASCII_CHARS.length - 1));
                            asciiFrame += ASCII_CHARS[charIndex];
                        }
                        asciiFrame += '\r\n';
                    }
                    
                    frameQueue.push(asciiFrame);

                    // Si on a généré trop d'images d'avance, on met FFmpeg en pause pour économiser la RAM
                    if (frameQueue.length > 60) {
                        imageStream.pause();
                    }
                }
            });

            // Boucle d'affichage cadencée précisément pour correspondre aux FPS (Vitesse normale)
            playInterval = setInterval(() => {
                if (frameQueue.length > 0) {
                    const frame = frameQueue.shift();
                    framesPlayed++;
                    
                    const currentSeconds = framesPlayed / FPS;
                    // On donne videoWidth à la barre de progression pour qu'elle ne touche pas le bord non plus
                    const pBar = generateProgressBar(currentSeconds, videoInfo.seconds, videoWidth);
                    
                    // On efface le caractère clignotant, on se replace en haut à gauche et on affiche l'image + la barre
                    socket.write('\x1B[H' + frame + pBar);

                    // Quand le tampon se vide, on réveille FFmpeg
                    if (frameQueue.length < 20 && imageStream.isPaused()) {
                        imageStream.resume();
                    }
                }
            }, FRAME_DELAY);

        } catch (err) {
            send(`\r\nErreur de lancement : ${err.message}\r\nAppuyez sur Entrée.\r\n`);
            stopVideo();
        }
    };

    socket.on('close', stopVideo);
    socket.on('error', stopVideo);
});

server.listen(PORT, () => {
    console.log(`=============================================`);
    console.log(` Serveur ATUBE en écoute sur le port ${PORT} `);
    console.log(`=============================================`);
});
