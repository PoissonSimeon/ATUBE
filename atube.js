'use strict';

const net     = require('net');
const ffmpeg  = require('fluent-ffmpeg');
const { PassThrough } = require('stream');
const { spawn }       = require('child_process');

// ─── Configuration ────────────────────────────────────────────────────────────
const PORT                   = 23;
const FPS                    = 15;
const FRAME_DELAY_MS         = 1000 / FPS;
const MAX_TOTAL_CONNECTIONS  = 20;
const MAX_CONNECTIONS_PER_IP = 3;
const IDLE_TIMEOUT_MS        = 5 * 60 * 1000;
const MAX_INPUT_LEN          = 120;
const MAX_YTDLP_BUFFER       = 8 * 1024 * 1024; // 8 MB
const MAX_FRAME_QUEUE        = 60;
const MIN_FRAME_QUEUE        = 20;
const SEARCH_COOLDOWN_MS     = 2000;
const YTDLP                  = '/usr/local/bin/yt-dlp';
const YTDLP_BASE_ARGS        = ['--no-config', '--no-cache-dir', '--no-warnings', '--no-playlist'];
const YOUTUBE_URL_RE         = /^https:\/\/(www\.youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[\w-]{11}/;
const ASCII_CHARS            = ' .:-=+*#%@';

// ─── Global state ─────────────────────────────────────────────────────────────
let activeConnections = 0;
const ipConnections   = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────
const formatTime = (secs) => {
    if (!secs || isNaN(secs)) return 'LIVE';
    return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
};

const parseTimecode = (t) => {
    const parts = t.split(':');
    const s = parseFloat(parts.pop().replace(',', '.'));
    const m = parseInt(parts.pop() || '0', 10);
    const h = parseInt(parts.pop() || '0', 10);
    return h * 3600 + m * 60 + s;
};

const sanitize = (input) => {
    let s = input.replace(/[^a-zA-Z0-9\s\-_.,?!'éèêëàâäùûüîïôöçñ¿¡+]/g, '').trim();
    while (s.startsWith('-')) s = s.slice(1).trim();
    return s;
};

const isValidYTUrl = (url) => typeof url === 'string' && YOUTUBE_URL_RE.test(url);

const makeProgressBar = (cur, total, isLive, width) => {
    if (isLive) {
        const s = ' [ EN DIRECT ] ';
        return s.padStart(Math.floor((width + s.length) / 2)).padEnd(width);
    }
    const timeStr = ` ${formatTime(cur)} / ${formatTime(total)} `;
    const barW    = width - timeStr.length - 2;
    if (barW < 4) return timeStr.slice(0, width);
    const fill  = Math.floor(barW * Math.min(cur / Math.max(total, 1), 1));
    const empty = barW - fill;
    return '[' + '='.repeat(fill) + (empty > 0 ? '>' : '') + ' '.repeat(Math.max(0, empty - 1)) + ']' + timeStr;
};

// ─── YouTube Search ───────────────────────────────────────────────────────────
const searchYouTube = (query) => new Promise((resolve, reject) => {
    const proc = spawn(YTDLP, [
        `ytsearch20:${query}`, '--dump-json', '--default-search', 'ytsearch',
        ...YTDLP_BASE_ARGS,
    ], { shell: false, cwd: '/tmp' });

    let raw = '';
    let capped = false;

    proc.stdout.on('data', (chunk) => {
        if (capped) return;
        raw += chunk.toString();
        if (raw.length > MAX_YTDLP_BUFFER) { capped = true; proc.kill('SIGTERM'); }
    });

    proc.on('close', () => {
        const results = raw.trim().split('\n').flatMap((line) => {
            try {
                const d = JSON.parse(line);
                if (!isValidYTUrl(d.webpage_url)) return [];
                const live = !!(d.is_live || d.duration === 0);
                return [{ title: String(d.title || '(Sans titre)').slice(0, 100), url: d.webpage_url,
                          timestamp: live ? 'LIVE' : formatTime(d.duration),
                          seconds: d.duration || 0, isLive: live }];
            } catch { return []; }
        });
        resolve(results);
    });

    proc.on('error', reject);
    proc.stderr.resume(); // drain stderr without buffering
});

// ─── Subtitle Fetcher ─────────────────────────────────────────────────────────
const fetchSubtitles = (url) => new Promise((resolve) => {
    if (!isValidYTUrl(url)) return resolve([]);

    const proc = spawn(YTDLP, ['-J', '--skip-download', ...YTDLP_BASE_ARGS, url], { shell: false, cwd: '/tmp' });

    let raw = '';
    let capped = false;

    proc.stdout.on('data', (chunk) => {
        if (capped) return;
        raw += chunk.toString();
        if (raw.length > MAX_YTDLP_BUFFER) { capped = true; proc.kill('SIGTERM'); }
    });

    proc.on('close', () => {
        try {
            const info = JSON.parse(raw);
            const subs = info.subtitles || {};
            const auto = info.automatic_captions || {};
            const lang = info.language;
            const PREFS = [lang, 'fr', 'fr-FR', 'en', 'en-US'].filter(Boolean);

            let track = null;
            for (const l of PREFS) if (subs[l]) { track = subs[l]; break; }
            if (!track) for (const l of PREFS) if (auto[l]) { track = auto[l]; break; }
            if (!track && Object.keys(subs).length) track = subs[Object.keys(subs)[0]];
            if (!track && Object.keys(auto).length) track = auto[Object.keys(auto)[0]];
            if (!track) return resolve([]);

            const fmt = track.find(f => f.ext === 'vtt') || track.find(f => f.ext === 'srt');
            if (!fmt?.url) return resolve([]);

            fetch(fmt.url)
                .then(r => r.text())
                .then(text => resolve(parseSubs(text)))
                .catch(() => resolve([]));
        } catch { resolve([]); }
    });

    proc.on('error', () => resolve([]));
    proc.stderr.resume();
});

const parseSubs = (text) => {
    const lines  = text.split(/\r?\n/);
    const parsed = [];
    let cur      = null;

    for (const line of lines) {
        const m = line.match(/(\d{2,}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2,}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})/);
        if (m) {
            if (cur) parsed.push(cur);
            cur = { start: parseTimecode(m[1]), end: parseTimecode(m[2]), text: '' };
        } else if (cur && line.trim() && !/^\d+$/.test(line) &&
                   !line.startsWith('WEBVTT') && !line.startsWith('align:') && !line.startsWith('STYLE')) {
            const t = line.replace(/<[^>]+>/g, '').trim();
            if (t) cur.text += (cur.text ? ' ' : '') + t;
        }
    }
    if (cur) parsed.push(cur);

    // Anti-rolling: remove word overlap with previous subtitle
    for (let i = 1; i < parsed.length; i++) {
        const prev = parsed[i - 1].text.split(/\s+/);
        const curr = parsed[i].text.split(/\s+/);
        let overlap = 0;
        for (let j = 1; j <= Math.min(prev.length, curr.length); j++) {
            if (prev.slice(-j).join(' ') === curr.slice(0, j).join(' ')) overlap = j;
        }
        if (overlap) parsed[i].text = curr.slice(overlap).join(' ');
    }

    // Group nearby subtitles into readable chunks
    const grouped = [];
    for (const sub of parsed.filter(s => s.text.trim())) {
        const last = grouped[grouped.length - 1];
        if (last && (sub.start - last.end) < 1.5 && (last.text.length + sub.text.length) < 70) {
            last.text += ' ' + sub.text;
            last.end   = Math.max(last.end, sub.end);
        } else {
            grouped.push({ ...sub });
        }
    }
    return grouped;
};

// ─── TCP Server ───────────────────────────────────────────────────────────────
const server = net.createServer((socket) => {
    const ip = socket.remoteAddress || 'unknown';

    // ── Connection limits ──────────────────────────────────────────────────────
    if (activeConnections >= MAX_TOTAL_CONNECTIONS) {
        socket.end('Serveur complet. Reessayez plus tard.\r\n');
        return;
    }
    const ipCount = ipConnections.get(ip) || 0;
    if (ipCount >= MAX_CONNECTIONS_PER_IP) {
        socket.end('Trop de connexions depuis votre IP.\r\n');
        return;
    }

    activeConnections++;
    ipConnections.set(ip, ipCount + 1);

    socket.setTimeout(IDLE_TIMEOUT_MS);
    socket.on('timeout', () => { write('\r\nDéconnexion pour inactivité.\r\n'); destroy(); });
    socket.on('error', () => {}); // handled via 'close'

    // ── Terminal dimensions ────────────────────────────────────────────────────
    let termW = 80, termH = 24;

    // ── App state ──────────────────────────────────────────────────────────────
    let state       = 'SEARCH';
    let results     = [];
    let lastQuery   = '';
    let page        = 0;
    let inputBuf    = '';
    let lastSearch  = 0; // timestamp for rate-limiting searches

    // ── Playback resources ─────────────────────────────────────────────────────
    let ytDlpProc    = null;
    let ffmpegProc   = null;
    let imgStream    = null;
    let playInterval = null;

    // ── Helpers ────────────────────────────────────────────────────────────────
    const write      = (data) => { if (!socket.destroyed && socket.writable) socket.write(data); };
    const clear      = ()     => write('\x1B[2J\x1B[H');
    const hideCursor = ()     => write('\x1B[?25l');
    const showCursor = ()     => write('\x1B[?25h');
    const destroy    = ()     => { if (!socket.destroyed) socket.destroy(); };

    // ── UI ─────────────────────────────────────────────────────────────────────
    const showSearch = () => {
        showCursor();
        clear();
        write('================================================================================\r\n');
        write('                                 *** ATUBE ***\r\n');
        write('                       YouTube directement dans ton CLI\r\n');
        write('================================================================================\r\n\r\n');
        write('Recherche YouTube (ou "quit" pour quitter) : ');
        state = 'SEARCH';
    };

    const showResults = () => {
        clear();
        const totalPages = Math.ceil(results.length / 5);
        write(`Résultats pour : "${lastQuery}" (Page ${page + 1}/${totalPages})\r\n\r\n`);
        const start = page * 5;
        for (let i = start; i < Math.min(start + 5, results.length); i++) {
            const v = results[i];
            write(`[${i - start + 1}] ${v.title} ${v.isLive ? '[EN DIRECT]' : `(${v.timestamp})`}\r\n`);
        }
        write('\r\n');
        if ((page + 1) * 5 < results.length) write('[n] Page suivante\r\n');
        if (page > 0)                         write('[p] Page précédente\r\n');
        write('[0] Nouvelle recherche\r\n\r\nChoisissez une option : ');
        state = 'SELECT';
    };

    // Negotiate terminal size via Telnet NAWS
    socket.write(Buffer.from([0xFF, 0xFD, 0x1F])); // IAC DO NAWS
    showSearch();

    // ── Input handler ──────────────────────────────────────────────────────────
    socket.on('data', async (raw) => {
        // Parse Telnet IAC sequences, extract pure data bytes
        let pure = [];
        let i = 0;
        while (i < raw.length) {
            if (raw[i] === 0xFF) {
                const cmd = raw[i + 1];
                if (cmd === 0xFA && raw[i + 2] === 0x1F && i + 8 < raw.length) {
                    // IAC SB NAWS W1 W0 H1 H0 IAC SE  (9 bytes)
                    termW = raw.readUInt16BE(i + 3);
                    termH = raw.readUInt16BE(i + 5);
                    i += 9;
                } else if (cmd >= 0xFB && cmd <= 0xFE && i + 2 < raw.length) {
                    // IAC WILL/WONT/DO/DONT <option>  (3 bytes)
                    i += 3;
                } else {
                    i += 2;
                }
            } else {
                pure.push(raw[i]);
                i++;
            }
        }

        if (!pure.length) return;
        const buf = Buffer.from(pure);

        // Ctrl+C / Ctrl+D → disconnect
        if (buf.includes(0x03) || buf.includes(0x04)) {
            stopPlayback();
            showCursor();
            write('\r\nAu revoir !\r\n');
            setTimeout(destroy, 100);
            return;
        }

        const str = buf.toString('utf8');

        // Backspace
        if (buf.length === 1 && (buf[0] === 0x08 || buf[0] === 0x7F)) {
            if (inputBuf.length > 0) { inputBuf = inputBuf.slice(0, -1); write('\b \b'); }
            return;
        }

        if (str.includes('\r') || str.includes('\n')) {
            const before = str.split(/[\r\n]/)[0];
            if (before && inputBuf.length < MAX_INPUT_LEN) inputBuf += before;
            const query = sanitize(inputBuf);
            inputBuf = '';

            if (state === 'PLAYING') { stopPlayback(); showSearch(); return; }

            if (query === 'quit' || query === 'exit') { write('\r\nAu revoir !\r\n'); destroy(); return; }

            if (state === 'SEARCH') {
                if (!query) { showSearch(); return; }
                const now = Date.now();
                if (now - lastSearch < SEARCH_COOLDOWN_MS) {
                    write('\r\nRecherche trop rapide. Veuillez patienter...\r\n');
                    return;
                }
                lastSearch = now;
                write(`\r\n\r\nRecherche en cours pour "${query}"...\r\n`);
                try {
                    results   = await searchYouTube(query);
                    lastQuery = query;
                    page      = 0;
                    if (results.length) { showResults(); }
                    else { write('\r\nAucun résultat. Appuyez sur Entrée pour réessayer.\r\n'); }
                } catch {
                    write('\r\nErreur de recherche. Appuyez sur Entrée pour réessayer.\r\n');
                }
                return;
            }

            if (state === 'SELECT') {
                if (query === '0') { showSearch(); return; }
                if (query.toLowerCase() === 'n' && (page + 1) * 5 < results.length) { page++; showResults(); return; }
                if (query.toLowerCase() === 'p' && page > 0) { page--; showResults(); return; }
                const n = parseInt(query, 10);
                if (n >= 1 && n <= 5) {
                    const idx = page * 5 + (n - 1);
                    if (idx < results.length) { startPlayback(results[idx]); return; }
                }
                write('\r\nChoix invalide. Choisissez une option : ');
            }
        } else {
            // Character echo during input
            if (state !== 'PLAYING' && inputBuf.length < MAX_INPUT_LEN) {
                const c = sanitize(str);
                if (c) { inputBuf += c; write(c); }
            }
        }
    });

    // ── Playback ───────────────────────────────────────────────────────────────
    const stopPlayback = () => {
        if (playInterval) { clearInterval(playInterval); playInterval = null; }
        if (imgStream)    { imgStream.destroy();          imgStream    = null; }
        if (ffmpegProc)   { ffmpegProc.kill('SIGKILL');   ffmpegProc   = null; }
        if (ytDlpProc)    { ytDlpProc.kill('SIGKILL');    ytDlpProc    = null; }
    };

    const startPlayback = (video) => {
        state = 'PLAYING';
        clear();
        hideCursor();
        write('Chargement du flux...\r\n');

        const vidW      = Math.max(20, termW - 10);
        const vidH      = Math.max(10, termH - 8);
        const frameSize = vidW * vidH;
        const padL      = Math.max(0, Math.floor((termW - vidW) / 2));
        const leftPad   = ' '.repeat(padL);

        let frameQueue = [];
        let frameCount = 0;
        let subtitles  = [];
        let ended      = false;

        fetchSubtitles(video.url).then(subs => { subtitles = subs; });

        ytDlpProc = spawn(YTDLP, [
            '-f', 'worst[ext=mp4]/worst',
            '-o', '-', '--quiet', '--no-exec',
            ...YTDLP_BASE_ARGS,
            video.url,
        ], { shell: false, cwd: '/tmp' });

        ytDlpProc.stderr.on('data', (d) => {
            const msg = d.toString();
            if (state === 'PLAYING' && msg.includes('ERROR:')) {
                write(`\r\nErreur yt-dlp : ${msg.trim()}\r\nAppuyez sur Entrée.\r\n`);
                stopPlayback();
            }
        });

        imgStream = new PassThrough();

        ffmpegProc = ffmpeg(ytDlpProc.stdout)
            .fps(FPS)
            .format('image2pipe')
            .videoCodec('rawvideo')
            .outputOptions([
                '-pix_fmt', 'gray',
                '-vf', `scale=iw:ih/2,scale=${vidW}:${vidH}:force_original_aspect_ratio=decrease,pad=${vidW}:${vidH}:-1:-1`,
            ])
            .on('error', (err) => {
                if (state === 'PLAYING' && !err.message.includes('SIGKILL')) {
                    write(`\r\nErreur ffmpeg : ${err.message}\r\nAppuyez sur Entrée.\r\n`);
                    stopPlayback();
                }
            });

        ffmpegProc.pipe(imgStream);

        let frameBuf = Buffer.alloc(0);

        imgStream.on('data', (chunk) => {
            frameBuf = Buffer.concat([frameBuf, chunk]);
            while (frameBuf.length >= frameSize) {
                const pixels = frameBuf.subarray(0, frameSize);
                frameBuf     = frameBuf.subarray(frameSize);

                let frame = '';
                for (let y = 0; y < vidH; y++) {
                    frame += leftPad;
                    for (let x = 0; x < vidW; x++) {
                        frame += ASCII_CHARS[Math.floor(pixels[y * vidW + x] / 255 * (ASCII_CHARS.length - 1))];
                    }
                    frame += '\x1B[K\r\n';
                }
                frameQueue.push(frame);
                if (frameQueue.length > MAX_FRAME_QUEUE) imgStream.pause();
            }
        });

        imgStream.on('end', () => { ended = true; });

        playInterval = setInterval(() => {
            if (socket.destroyed || !socket.writable) { stopPlayback(); return; }

            if (!frameQueue.length) {
                if (ended) { stopPlayback(); showSearch(); }
                return;
            }

            const frame = frameQueue.shift();
            frameCount++;
            const now = frameCount / FPS;

            // Find active subtitle
            let subLine = '\x1B[K';
            const activeSub = subtitles.filter(s => now >= s.start && now <= s.end).pop();
            if (activeSub) {
                const t   = activeSub.text.replace(/\n/g, ' ').trim().slice(0, vidW);
                const pad = Math.max(0, Math.floor((vidW - t.length) / 2));
                subLine   = leftPad + ' '.repeat(pad) + t + '\x1B[K';
            }

            const pbar = makeProgressBar(now, video.seconds, video.isLive, vidW);
            write('\x1B[H' + frame + subLine + '\r\n' + leftPad + pbar + '\x1B[K\r\n\x1B[J');

            if (frameQueue.length < MIN_FRAME_QUEUE && imgStream?.isPaused()) imgStream.resume();
        }, FRAME_DELAY_MS);
    };

    // ── Disconnect cleanup (fires exactly once via 'close') ────────────────────
    socket.on('end', destroy); // force-close on remote FIN
    socket.on('close', () => {
        stopPlayback();
        activeConnections = Math.max(0, activeConnections - 1);
        const n = ipConnections.get(ip) || 1;
        if (n <= 1) ipConnections.delete(ip);
        else        ipConnections.set(ip, n - 1);
    });
});

server.on('error', (err) => { console.error('[SERVEUR] Erreur fatale :', err.message); process.exit(1); });

server.listen(PORT, '0.0.0.0', () => {
    console.log(`=============================================`);
    console.log(` Serveur ATUBE en écoute sur le port ${PORT} `);
    console.log(`=============================================`);

    if (process.getuid?.() === 0) {
        try {
            process.env.HOME = '/tmp';
            process.chdir('/tmp');
            process.setgid('nogroup');
            process.setuid('nobody');
            console.log('✅ Privilèges root abandonnés → nobody:nogroup');
        } catch (err) {
            console.error('❌ ERREUR FATALE : Impossible de réduire les privilèges :', err.message);
            process.exit(1);
        }
    } else {
        console.warn('⚠️  Non exécuté en root — port 23 risque d\'échouer.');
    }
});

process.on('uncaughtException',  (err)    => console.error('[uncaughtException]',  err.message));
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
