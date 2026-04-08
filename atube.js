const net = require('net');
const ffmpeg = require('fluent-ffmpeg');
const { PassThrough } = require('stream');
const { spawn } = require('child_process');

// --- Configuration Générale ---
const PORT = 2323;
const ASCII_CHARS = [' ', '.', ':', '-', '=', '+', '*', '#', '%', '@'];
const FPS = 15;
const FRAME_DELAY = 1000 / FPS;

// Utilitaires de Temps
const formatTime = (secs) => {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = Math.floor(secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
};

const parseTime = (t) => {
    const parts = t.split(':');
    let secs = parseFloat(parts.pop().replace(',', '.')); 
    let mins = parseInt(parts.pop() || '0');
    let hrs = parseInt(parts.pop() || '0');
    return hrs * 3600 + mins * 60 + secs;
};

// --- Moteur de Recherche via yt-dlp ---
const searchYoutube = (query) => {
    return new Promise((resolve, reject) => {
        const searchProc = spawn('yt-dlp', [
            `ytsearch20:${query}`,
            '--dump-json',
            '--default-search', 'ytsearch',
            '--no-playlist'
        ]);
        let out = '';
        searchProc.stdout.on('data', d => out += d.toString());
        searchProc.on('close', code => {
            if (code !== 0 && out.length === 0) return reject(new Error('Search failed'));
            const results = out.trim().split('\n').map(line => {
                try {
                    const data = JSON.parse(line);
                    return {
                        title: data.title,
                        url: data.webpage_url,
                        timestamp: formatTime(data.duration || 0),
                        seconds: data.duration || 0
                    };
                } catch(e) { return null; }
            }).filter(r => r !== null);
            resolve(results);
        });
        searchProc.on('error', reject);
    });
};

// --- Gestionnaire de Sous-titres (VTT) avec Déduplication (Anti-Rolling) ---
const fetchSubtitles = async (url) => {
    return new Promise((resolve) => {
        const process = spawn('yt-dlp', ['-J', '--skip-download', url]);
        let out = '';
        process.stdout.on('data', d => out += d.toString());
        process.on('close', async () => {
            try {
                const info = JSON.parse(out);
                const subs = info.subtitles || {};
                const autoSubs = info.automatic_captions || {};
                
                let subTrack = subs['fr'] || subs['fr-FR'] || subs['en'] || subs['en-US'];
                if (!subTrack && Object.keys(subs).length > 0) subTrack = subs[Object.keys(subs)[0]];
                
                if (!subTrack) subTrack = autoSubs['fr'] || autoSubs['fr-FR'] || autoSubs['en'] || autoSubs['en-US'];
                if (!subTrack && Object.keys(autoSubs).length > 0) subTrack = autoSubs[Object.keys(autoSubs)[0]];
                
                if (subTrack) {
                    const format = subTrack.find(f => f.ext === 'vtt') || subTrack.find(f => f.ext === 'srt');
                    
                    if (format && format.url) {
                        const res = await fetch(format.url);
                        const text = await res.text();
                        
                        const parsed = [];
                        const lines = text.split(/\r?\n/);
                        let currentSub = null;
                        
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i];
                            const match = line.match(/(\d{2,}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2,}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})/);
                            if (match) {
                                if (currentSub) parsed.push(currentSub);
                                currentSub = {
                                    start: parseTime(match[1]),
                                    end: parseTime(match[2]),
                                    text: ''
                                };
                            } else if (currentSub && line.trim() !== '' && !line.match(/^\d+$/) && !line.startsWith('WEBVTT')) {
                                let cleanText = line.replace(/<[^>]+>/g, '').trim();
                                if (!cleanText.startsWith('align:') && !cleanText.startsWith('STYLE')) {
                                    currentSub.text += (currentSub.text ? ' ' : '') + cleanText;
                                }
                            }
                        }
                        if (currentSub) parsed.push(currentSub);

                        parsed.forEach(sub => sub.originalText = sub.text);

                        for (let i = 1; i < parsed.length; i++) {
                            let prevWords = parsed[i-1].originalText.trim().split(/\s+/);
                            let currWords = parsed[i].originalText.trim().split(/\s+/);

                            let maxOverlapWords = 0;
                            let maxSearch = Math.min(prevWords.length, currWords.length);

                            for (let j = 1; j <= maxSearch; j++) {
                                let match = true;
                                for (let k = 0; k < j; k++) {
                                    if (prevWords[prevWords.length - j + k] !== currWords[k]) {
                                        match = false;
                                        break;
                                    }
                                }
                                if (match) {
                                    maxOverlapWords = j;
                                }
                            }

                            if (maxOverlapWords > 0) {
                                currWords.splice(0, maxOverlapWords);
                                parsed[i].text = currWords.join(' ');
                            }
                        }

                        const finalParsed = parsed.filter(sub => sub.text.trim().length > 0);
                        
                        const groupedSubs = [];
                        if (finalParsed.length > 0) {
                            let currentGroup = { ...finalParsed[0] };
                            for (let i = 1; i < finalParsed.length; i++) {
                                const nextSub = finalParsed[i];
                                const gap = nextSub.start - currentGroup.end;
                                
                                if (gap < 1.5 && (currentGroup.text.length + nextSub.text.length) < 70) {
                                    currentGroup.text += ' ' + nextSub.text;
                                    currentGroup.end = Math.max(currentGroup.end, nextSub.end);
                                } else {
                                    groupedSubs.push(currentGroup);
                                    currentGroup = { ...nextSub };
                                }
                            }
                            groupedSubs.push(currentGroup);
                        }

                        return resolve(groupedSubs);
                    }
                }
            } catch(e) {
                console.error("Erreur parsing sous-titres :", e.message);
            }
            resolve([]);
        });
    });
};

const server = net.createServer((socket) => {
    let termWidth = 80;
    let termHeight = 24;

    let state = 'SEARCH';
    let searchResults = [];
    let inputBuffer = '';
    
    // Variables pour la pagination
    let lastQuery = '';
    let currentPage = 0;
    
    let currentFfmpeg = null;
    let currentYtDlp = null;
    let playInterval = null;

    const send = (msg) => {
        if (!socket.destroyed && socket.writable) {
            socket.write(msg);
        }
    };
    
    const clear = () => send('\x1B[2J\x1B[H');
    const hideCursor = () => send('\x1B[?25l');
    const showCursor = () => send('\x1B[?25h');

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

    const displayResults = () => {
        clear();
        const totalPages = Math.ceil(searchResults.length / 5);
        send(`Résultats pour : "${lastQuery}" (Page ${currentPage + 1}/${totalPages})\r\n\r\n`);
        
        const start = currentPage * 5;
        const end = Math.min(start + 5, searchResults.length);
        
        for (let i = start; i < end; i++) {
            const v = searchResults[i];
            send(`[${i - start + 1}] ${v.title} (${v.timestamp})\r\n`);
        }
        
        send('\r\n');
        if (end < searchResults.length) send('[n] Page suivante\r\n');
        if (currentPage > 0) send('[p] Page précédente\r\n');
        send('[0] Nouvelle recherche\r\n\r\n');
        send('Choisissez une option : ');
    };

    promptSearch();

    socket.on('data', async (rawBuffer) => {
        // Option de sortie propre de secours
        if (rawBuffer.includes(0x03) || rawBuffer.includes(0x04)) {
            stopVideo();
            showCursor();
            send('\r\n\x1B[0mDéconnexion.\r\n');
            setTimeout(() => socket.destroy(), 100); 
            return;
        }

        let pureData = Buffer.alloc(0);
        let i = 0;
        while (i < rawBuffer.length) {
            if (rawBuffer[i] === 255) {
                if (i + 2 < rawBuffer.length && rawBuffer[i+1] === 250 && rawBuffer[i+2] === 31) {
                    if (i + 8 < rawBuffer.length) {
                        termWidth = rawBuffer.readUInt16BE(i + 3);
                        termHeight = rawBuffer.readUInt16BE(i + 5);
                        i += 9;
                    } else break;
                } else if (i + 1 < rawBuffer.length && rawBuffer[i+1] >= 251 && rawBuffer[i+1] <= 254) {
                    i += 3;
                } else i += 2;
            } else {
                pureData = Buffer.concat([pureData, Buffer.from([rawBuffer[i]])]);
                i++;
            }
        }

        const str = pureData.toString();
        if (!str) return;

        if (str.includes('\n') || str.includes('\r')) {
            const parts = str.split(/[\r\n]+/);
            if (parts[0] && inputBuffer.length < 255) inputBuffer += parts[0];

            const query = inputBuffer.trim();
            inputBuffer = ''; 

            if (state === 'PLAYING') {
                stopVideo();
                promptSearch();
                return;
            }

            if (query.toLowerCase() === 'quit' || query.toLowerCase() === 'exit') {
                send('\r\nAu revoir !\r\n');
                socket.destroy();
                return;
            }

            if (state === 'SEARCH') {
                if (!query) { promptSearch(); return; }
                send('\r\n\r\nRecherche en cours pour "' + query + '"...\r\n');
                try {
                    searchResults = await searchYoutube(query);
                    lastQuery = query;
                    currentPage = 0;
                    
                    if (searchResults.length > 0) {
                        state = 'SELECT';
                        displayResults();
                    } else {
                        send('\r\nAucun résultat trouvé. Appuyez sur Entrée pour réessayer.\r\n');
                        state = 'SEARCH';
                    }
                } catch (e) {
                    send('\r\nErreur lors de la recherche. Appuyez sur Entrée pour réessayer.\r\n');
                    state = 'SEARCH';
                }
            } else if (state === 'SELECT') {
                const qLower = query.toLowerCase();
                
                if (query === '0') {
                    promptSearch();
                } else if ((qLower === 'n' || qLower === 'next') && (currentPage + 1) * 5 < searchResults.length) {
                    currentPage++;
                    displayResults();
                } else if ((qLower === 'p' || qLower === 'prev') && currentPage > 0) {
                    currentPage--;
                    displayResults();
                } else {
                    const choice = parseInt(query);
                    if (choice >= 1 && choice <= 5) {
                        const absIndex = currentPage * 5 + (choice - 1);
                        if (absIndex < searchResults.length) {
                            playVideo(searchResults[absIndex]);
                        } else {
                            send('\r\nChoix invalide. Choisissez une option : ');
                        }
                    } else {
                        send('\r\nChoix invalide. Choisissez une option : ');
                    }
                }
            }
        } else {
            if (pureData[0] === 0x08 || pureData[0] === 0x7f) { 
                if (inputBuffer.length > 0) {
                    inputBuffer = inputBuffer.slice(0, -1);
                    send('\b \b');
                }
            } else {
                if (inputBuffer.length < 255) {
                    inputBuffer += str;
                    send(str);
                }
            }
        }
    });

    const stopVideo = () => {
        if (playInterval) { clearInterval(playInterval); playInterval = null; }
        if (currentFfmpeg) { currentFfmpeg.kill('SIGKILL'); currentFfmpeg = null; }
        if (currentYtDlp) { currentYtDlp.kill('SIGKILL'); currentYtDlp = null; }
    };

    const generateProgressBar = (currentSecs, totalSecs, width) => {
        const timeStr = ` ${formatTime(currentSecs)} / ${formatTime(totalSecs)} `;
        const barWidth = width - timeStr.length - 2; 
        
        if (barWidth < 5) return timeStr.padStart(width, ' '); 

        const progress = totalSecs > 0 ? Math.min(currentSecs / totalSecs, 1) : 0;
        const filled = Math.floor(barWidth * progress);
        const empty = barWidth - filled;
        
        return '[' + '='.repeat(filled) + '>'.repeat(empty > 0 ? 1 : 0) + ' '.repeat(Math.max(0, empty - 1)) + ']' + timeStr;
    };

    const playVideo = (videoInfo) => {
        state = 'PLAYING';
        clear();
        hideCursor();
        send('Mise en cache du flux et des sous-titres...\r\n');

        const videoWidth = Math.max(20, termWidth - 10);
        const videoHeight = Math.max(10, termHeight - 8); 
        const frameByteSize = videoWidth * videoHeight;

        const padLeft = Math.max(0, Math.floor((termWidth - videoWidth) / 2));
        const padTop = Math.max(0, Math.floor((termHeight - videoHeight - 2) / 2));

        let frameQueue = [];
        let framesPlayed = 0;
        let currentSubtitles = [];

        fetchSubtitles(videoInfo.url).then(subs => {
            currentSubtitles = subs;
        });

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

            // MAGIE FFMPEG: On réduit de moitié la hauteur d'abord (caractères de terminal), 
            // on adapte avec conservation du ratio, et on remplit avec du noir (centrage automatique avec -1:-1)
            currentFfmpeg = ffmpeg(currentYtDlp.stdout)
                .fps(FPS)
                .format('image2pipe')
                .videoCodec('rawvideo')
                .outputOptions([
                    '-pix_fmt gray',
                    '-vf', `scale=iw:ih/2,scale=${videoWidth}:${videoHeight}:force_original_aspect_ratio=decrease,pad=${videoWidth}:${videoHeight}:-1:-1`
                ])
                .on('error', (err) => {
                    if (err.message && !err.message.includes('SIGKILL')) {
                        console.error('\r\nErreur interne FFmpeg:', err.message);
                    }
                });

            currentFfmpeg.pipe(imageStream);

            let frameBuffer = Buffer.alloc(0);

            imageStream.on('data', (chunk) => {
                frameBuffer = Buffer.concat([frameBuffer, chunk]);

                while (frameBuffer.length >= frameByteSize) {
                    const frameData = frameBuffer.subarray(0, frameByteSize);
                    frameBuffer = frameBuffer.subarray(frameByteSize);

                    let asciiFrame = '\r\n'.repeat(padTop); 
                    for (let y = 0; y < videoHeight; y++) {
                        asciiFrame += ' '.repeat(padLeft);
                        for (let x = 0; x < videoWidth; x++) {
                            const pixelVal = frameData[y * videoWidth + x];
                            const charIndex = Math.floor((pixelVal / 255) * (ASCII_CHARS.length - 1));
                            asciiFrame += ASCII_CHARS[charIndex];
                        }
                        asciiFrame += '\x1B[K\r\n';
                    }
                    
                    frameQueue.push(asciiFrame);

                    if (frameQueue.length > 60) {
                        imageStream.pause();
                    }
                }
            });

            playInterval = setInterval(() => {
                if (socket.destroyed || !socket.writable) {
                    stopVideo();
                    socket.destroy();
                    return;
                }

                if (frameQueue.length > 0) {
                    const frame = frameQueue.shift();
                    framesPlayed++;
                    
                    const currentSeconds = framesPlayed / FPS;
                    
                    let subText = "";
                    if (currentSubtitles.length > 0) {
                        const activeSubs = currentSubtitles.filter(s => currentSeconds >= s.start && currentSeconds <= s.end);
                        if (activeSubs.length > 0) {
                            const activeSub = activeSubs[activeSubs.length - 1];
                            subText = activeSub.text.replace(/\n/g, ' ').trim();
                            if (subText.length > videoWidth) {
                                subText = subText.substring(0, videoWidth - 3) + '...';
                            }
                        }
                    }
                    
                    let subLine = '\x1B[K'; 
                    if (subText) {
                        const subPad = Math.max(0, Math.floor((videoWidth - subText.length) / 2));
                        subLine = ' '.repeat(padLeft + subPad) + subText + '\x1B[K';
                    }

                    const pBar = generateProgressBar(currentSeconds, videoInfo.seconds, videoWidth);
                    const pBarLine = ' '.repeat(padLeft) + pBar + '\x1B[K';
                    
                    socket.write('\x1B[H' + frame + subLine + '\r\n' + pBarLine + '\r\n\x1B[J');

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

    socket.on('end', () => {
        stopVideo();
        socket.destroy();
    });

    socket.on('close', () => {
        stopVideo();
        socket.destroy();
    });

    socket.on('error', (err) => {
        stopVideo();
        socket.destroy();
    });
});

server.listen(PORT, () => {
    console.log(`=============================================`);
    console.log(` Serveur ATUBE en écoute sur le port ${PORT} `);
    console.log(`=============================================`);
});
