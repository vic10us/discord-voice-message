// ==UserScript==
// @name            Voice Message (Discord Web)
// @namespace       https://github.com/vic10us/discord-voice-message
// @version         1.0.15
// @description     Adds a voice‑message recorder to Discord's web client
// @author          vic10us
// @match           https://*.discord.com/app
// @match           https://*.discord.com/channels/*
// @match           https://*.discord.com/login
// @license         MIT
// @homepageURL     https://github.com/vic10us/discord-voice-message
// @supportURL      https://github.com/vic10us/discord-voice-message/issues
// @icon            https://vic10us.github.io/discord-voice-message/images/icon128.png
// @downloadURL     https://raw.githubusercontent.com/vic10us/discord-voice-message/master/voice-message.user.js
// @updateURL       https://raw.githubusercontent.com/vic10us/discord-voice-message/master/voice-message.user.js
// @contributionURL https://www.buymeacoffee.com/vitim
// @grant           none
// @attribution     Original project (https://github.com/vic10us/discord-voice-message)
// @run-at          document-idle
// ==/UserScript==

(function () {
    'use strict';
    let DEBUG = false; // set to true for verbose logging and token retrieval attempts
    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------
    function log(...args) {
        if (DEBUG)
        console.log('[VoiceMessage]', ...args);
    }
    function error(...args) {
        console.error('[VoiceMessage]', ...args);
    }
    function debug(...args) {
        if (DEBUG)
        console.debug('[VoiceMessage]', ...args);
    }

    // Grab the auth token. Discord deletes `token` from the page's own
    // localStorage, so read it via a throwaway iframe (that copy still has it).
    // Token is JSON-encoded (quoted), so JSON.parse it. Webpack fallback if blocked.
    function getDiscordToken() {
        // 1) iframe localStorage (works on older builds that still keep `token`)
        try {
            window.dispatchEvent(new Event('beforeunload'));
            const iframe = document.body.appendChild(document.createElement('iframe'));
            const LS = iframe.contentWindow.localStorage;
            const raw = LS.token;
            iframe.remove();
            if (raw) {
                const token = JSON.parse(raw);
                log('Token retrieved via iframe localStorage (length:', token.length, ')');
                return token;
            }
        } catch (e) {
            debug('iframe localStorage path failed:', e);
        }

        // 2) Webpack scan — find ANY module export exposing getToken().
        // Discord moves the function between export shapes (default / Z / ZP /
        // bare) across builds, so check them all instead of hardcoding one path.
        try {
            let found = null;
            let foundArr = [];
            window.webpackChunkdiscord_app.push([[Symbol()], {}, req => {
                for (const id in req.c) {
                    const exp = req.c[id] && req.c[id].exports;
                    if (!exp) continue;
                    for (const shape of [exp, exp.default, exp.Z, exp.ZP]) {
                        if (shape && typeof shape.getToken === 'function') {
                            if (shape.getToken.name === 'getToken') {
                                found = shape.getToken;
                                foundArr.push(found);
                            }
                        }
                    }
                }
            }]);
            if (found) {
                window.foundArr = foundArr; // expose all found getToken exports for debugging
                const token = found();
                if (token) {
                    log('Token retrieved via webpack scan (length:', token.length, ')');
                    return token;
                }
            }
            debug('webpack scan found no getToken export');
        } catch (e) {
            debug('webpack scan failed:', e);
        }

        error('No Discord token found via iframe or webpack.');
        return '';
    }

    // Self-contained toast that mimics Discord's. Never blocks the UI (no alert).
    // Stacks bottom-center, auto-dismisses, animates in/out.
    function showToast(text, type = 'default') {
        // Lazily create our own stacking container (independent of Discord's DOM)
        let stack = document.getElementById('vm-toast-stack');
        if (!stack) {
            stack = document.createElement('div');
            stack.id = 'vm-toast-stack';
            Object.assign(stack.style, {
                position: 'fixed',
                bottom: '24px',
                left: '50%',
                transform: 'translateX(-50%)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '8px',
                zIndex: 100000,
                pointerEvents: 'none'
            });
            document.body.appendChild(stack);
        }

        const accent =
            type === 'success' ? '#43b581' :
            type === 'danger'  ? '#f04747' :
            type === 'warning' ? '#faa61a' :
                                 '#5865f2'; // Discord blurple

        const toast = document.createElement('div');
        toast.textContent = text;
        Object.assign(toast.style, {
            maxWidth: '440px',
            padding: '12px 16px',
            borderRadius: '8px',
            background: '#18191c',            // Discord dark toast bg
            color: '#f2f3f5',
            font: '500 14px/1.3 "gg sans", "Helvetica Neue", Helvetica, Arial, sans-serif',
            borderLeft: `4px solid ${accent}`,
            boxShadow: '0 8px 16px rgba(0,0,0,0.24)',
            pointerEvents: 'auto',
            opacity: '0',
            transform: 'translateY(8px)',
            transition: 'opacity 0.15s ease, transform 0.15s ease'
        });
        stack.appendChild(toast);

        // Animate in (next frame so the transition fires)
        requestAnimationFrame(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateY(0)';
        });

        // Animate out + remove
        const dismiss = () => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(8px)';
            setTimeout(() => {
                toast.remove();
                if (stack && !stack.childElementCount) stack.remove();
            }, 200);
        };
        const timer = setTimeout(dismiss, 3000);
        toast.addEventListener('click', () => { clearTimeout(timer); dismiss(); });
    }

    // -----------------------------------------------------------------------
    // WebM(Opus) -> Ogg(Opus) remux.
    // Chrome's MediaRecorder emits WebM/Opus; Discord *mobile* only decodes
    // Ogg/Opus (desktop is Chromium so WebM plays there — hence "works on
    // desktop, silent on mobile"). The Opus frames are identical, so we just
    // repackage them into an Ogg container — no re-encode, no deps, CSP-safe.
    // -----------------------------------------------------------------------
    function writeU16LE(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; }
    function writeU32LE(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff; }
    function writeU64LE(b, o, v) { writeU32LE(b, o, v >>> 0); writeU32LE(b, o + 4, Math.floor(v / 4294967296) >>> 0); }

    // Ogg CRC32: poly 0x04c11db7, no reflection, init 0
    const OGG_CRC_TABLE = (function () {
        const t = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let r = i << 24;
            for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
            t[i] = r >>> 0;
        }
        return t;
    })();
    function oggCrc(data) {
        let crc = 0;
        for (let i = 0; i < data.length; i++) {
            crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ data[i]) & 0xff]) >>> 0;
        }
        return crc >>> 0;
    }

    // EBML variable-int readers
    function ebmlReadId(buf, pos) {
        const first = buf[pos];
        let len = 1, mask = 0x80;
        while (len <= 4 && !(first & mask)) { mask >>= 1; len++; }
        let id = 0;
        for (let i = 0; i < len; i++) id = (id << 8) | buf[pos + i];
        return { id: id >>> 0, length: len };
    }
    function ebmlReadSize(buf, pos) {
        const first = buf[pos];
        let len = 1, mask = 0x80;
        while (len <= 8 && !(first & mask)) { mask >>= 1; len++; }
        let value = first & (mask - 1);
        for (let i = 1; i < len; i++) value = value * 256 + buf[pos + i];
        return { value, length: len };
    }

    // Walk the WebM, pull the OpusHead (CodecPrivate) + every Opus packet
    function parseWebmOpus(buf) {
        let opusHead = null;
        const packets = [];
        const MASTER = new Set([0x18538067, 0x1654AE6B, 0xAE, 0xE1, 0x1F43B675, 0xA0]);
        function walk(start, end) {
            let pos = start;
            while (pos < end) {
                const id = ebmlReadId(buf, pos); pos += id.length;
                const sz = ebmlReadSize(buf, pos); pos += sz.length;
                const dataStart = pos;
                const dataEnd = Math.min(dataStart + sz.value, end); // clamp unknown sizes
                if (MASTER.has(id.id)) {
                    walk(dataStart, dataEnd);
                } else if (id.id === 0x63A2) { // CodecPrivate = OpusHead
                    opusHead = buf.slice(dataStart, dataEnd);
                } else if (id.id === 0xA3 || id.id === 0xA1) { // SimpleBlock / Block
                    let p = dataStart;
                    const trk = ebmlReadSize(buf, p); p += trk.length; // track number
                    p += 2; // int16 timecode
                    p += 1; // flags byte (MediaRecorder audio = no lacing)
                    packets.push(buf.slice(p, dataEnd));
                }
                pos = dataEnd;
            }
        }
        walk(0, buf.length);
        return { opusHead, packets };
    }

    // Opus packet duration in 48kHz samples (from the TOC byte)
    function opusPacketSamples(pkt) {
        const toc = pkt[0];
        const config = toc >> 3;
        const code = toc & 0x3;
        const frameMs = [10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 10, 20,
            2.5, 5, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20][config];
        let frames = 1;
        if (code === 1 || code === 2) frames = 2;
        else if (code === 3) frames = pkt[1] & 0x3f;
        return Math.round(frameMs * 48) * frames;
    }

    function makeOpusHead(channels) {
        const out = new Uint8Array(19);
        out.set(new TextEncoder().encode('OpusHead'), 0);
        out[8] = 1;            // version
        out[9] = channels;     // channel count
        writeU16LE(out, 10, 3840); // pre-skip
        writeU32LE(out, 12, 48000); // input sample rate
        writeU16LE(out, 16, 0);     // output gain
        out[18] = 0;          // channel mapping family 0
        return out;
    }
    function makeOpusTags() {
        const enc = new TextEncoder();
        const vendor = enc.encode('voice-message.user.js');
        const out = new Uint8Array(8 + 4 + vendor.length + 4);
        out.set(enc.encode('OpusTags'), 0);
        writeU32LE(out, 8, vendor.length);
        out.set(vendor, 12);
        writeU32LE(out, 12 + vendor.length, 0); // 0 user comments
        return out;
    }

    // Build one Ogg page wrapping a single Opus packet
    function makeOggPage(serial, seq, headerType, granule, packet) {
        const lac = [];
        const n = Math.floor(packet.length / 255);
        for (let i = 0; i < n; i++) lac.push(255);
        lac.push(packet.length % 255);
        const segCount = lac.length;
        const page = new Uint8Array(27 + segCount + packet.length);
        page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
        page[4] = 0;            // stream structure version
        page[5] = headerType;   // 0x02 BOS, 0x04 EOS, 0x00 normal
        writeU64LE(page, 6, granule);
        writeU32LE(page, 14, serial);
        writeU32LE(page, 18, seq);
        // CRC (offset 22) left zero for computation
        page[26] = segCount;
        page.set(lac, 27);
        page.set(packet, 27 + segCount);
        writeU32LE(page, 22, oggCrc(page));
        return page;
    }

    function webmOpusToOgg(webmBytes) {
        const { opusHead, packets } = parseWebmOpus(webmBytes);
        if (!packets.length) throw new Error('no Opus packets found in WebM');
        const serial = 0x564f4943; // arbitrary fixed serial ("VOIC")
        let seq = 0;
        const pages = [
            makeOggPage(serial, seq++, 0x02, 0, opusHead || makeOpusHead(1)),
            makeOggPage(serial, seq++, 0x00, 0, makeOpusTags())
        ];
        let granule = 0;
        for (let i = 0; i < packets.length; i++) {
            granule += opusPacketSamples(packets[i]);
            const isLast = i === packets.length - 1;
            pages.push(makeOggPage(serial, seq++, isLast ? 0x04 : 0x00, granule, packets[i]));
        }
        const total = pages.reduce((s, p) => s + p.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const p of pages) { out.set(p, off); off += p.length; }
        return out;
    }

    // -----------------------------------------------------------------------
    // Find the chat-bar buttons toolbar (gift / gif / sticker / emoji row).
    // Class hash (e.g. buttons__74017) changes on Discord updates, so match
    // the stable `buttons_` prefix scoped to the message <form>.
    // -----------------------------------------------------------------------
    function findButtonsContainer() {
        // The chat-bar toolbar is the `buttons_` container that holds the
        // emoji / gif / sticker / gift buttons. Use those known aria-labels
        // to disambiguate from the many other `buttons_` containers on the page.
        const anchor = document.querySelector(
            'main form [aria-label="Select emoji" i],' +
            'main form [aria-label="Open GIF picker" i],' +
            'main form [aria-label="Open sticker picker" i],' +
            'main form [aria-label="Send a gift" i]'
        );
        if (anchor) {
            const container = anchor.closest('[class*="buttons_"]');
            if (container) {
                // log('Found chat-bar buttons container via toolbar anchor:', container);
                return container;
            }
            // debug('Toolbar anchor found but no buttons_ ancestor:', anchor);
        }

        // Fallback: the buttons_ container with the most child buttons inside
        // the message form (the toolbar has the most: emoji/gif/sticker/etc).
        const form = document.querySelector('main form');
        if (form) {
            const candidates = Array.from(form.querySelectorAll('[class*="buttons_"]'));
            let best = null, bestCount = 0;
            for (const c of candidates) {
                const n = c.querySelectorAll('button').length;
                if (n > bestCount) { bestCount = n; best = c; }
            }
            if (best) {
                //log('Found buttons container via most-buttons fallback (', bestCount, 'buttons):', best);
                return best;
            }
        }

        debug('Buttons container not found yet.');
        return null;
    }

    // -----------------------------------------------------------------------
    // Inject the voice button next to the send button
    // -----------------------------------------------------------------------
    // One-time stylesheet so the button matches Discord's native toolbar icons
    // (uses Discord's own CSS vars for color/hover, plus a recording pulse).
    function ensureVoiceStyles() {
        if (document.getElementById('vm-voice-styles')) return;
        const style = document.createElement('style');
        style.id = 'vm-voice-styles';
        style.textContent = `
            .voice-message-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 32px;
                height: 32px;
                margin: 0 2px;
                padding: 0;
                background: transparent;
                border: none;
                border-radius: 8px;
                cursor: pointer;
                color: var(--interactive-normal, #b5bac1);
                transition: color .15s ease, background-color .15s ease;
                -webkit-tap-highlight-color: transparent;
            }
            .voice-message-btn:hover {
                color: var(--interactive-hover, #dbdee1);
                background: var(--background-modifier-hover, rgba(255,255,255,.06));
            }
            .voice-message-btn:active { transform: scale(.92); }
            .voice-message-btn svg { width: 22px; height: 22px; }
            .voice-message-btn.recording {
                color: #f23f42;
                background: rgba(242,63,66,.12);
                animation: vm-pulse 1.2s ease-in-out infinite;
            }
            @keyframes vm-pulse {
                0%, 100% { box-shadow: 0 0 0 0 rgba(242,63,66,.45); }
                50%      { box-shadow: 0 0 0 4px rgba(242,63,66,0); }
            }
            .vm-cancel-btn {
                display: none;
                align-items: center;
                justify-content: center;
                width: 32px;
                height: 32px;
                margin: 0 2px;
                padding: 0;
                background: transparent;
                border: none;
                border-radius: 8px;
                cursor: pointer;
                color: var(--interactive-normal, #b5bac1);
                transition: color .15s ease, background-color .15s ease;
            }
            .vm-cancel-btn:hover {
                color: #f23f42;
                background: var(--background-modifier-hover, rgba(255,255,255,.06));
            }
            .vm-cancel-btn svg { width: 20px; height: 20px; }
            .vm-cancel-btn.show { display: flex; }
            .vm-timer {
                display: none;
                align-items: center;
                font: 600 13px/1 var(--font-primary, "gg sans"), monospace;
                color: #f23f42;
                font-variant-numeric: tabular-nums;
                padding: 0 2px;
                user-select: none;
            }
            .vm-timer.show { display: flex; }
        `;
        document.head.appendChild(style);
    }

    function injectVoiceButton(container) {
        if (!container) {
            error('Buttons container not found – aborting injection.');
            return;
        }
        // Avoid duplicate injections
        if (container.querySelector('.voice-message-btn')) return;

        ensureVoiceStyles();

        const voiceBtn = document.createElement('button');
        voiceBtn.className = 'voice-message-btn';
        voiceBtn.type = 'button';
        voiceBtn.title = 'Click to record a voice message';
        voiceBtn.setAttribute('aria-label', 'Record voice message');
        voiceBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path fill="currentColor" d="M12 2a3 3 0 0 0-3 3v6a3 3 0 1 0 6 0V5a3 3 0 0 0-3-3Z"/>
                <path fill="currentColor" d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.93V20H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.07A7 7 0 0 0 19 11Z"/>
            </svg>
        `;

        // Live timer + cancel button, shown only while recording
        const timerEl = document.createElement('div');
        timerEl.className = 'vm-timer';
        timerEl.textContent = '0:00';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'vm-cancel-btn';
        cancelBtn.type = 'button';
        cancelBtn.title = 'Discard recording';
        cancelBtn.setAttribute('aria-label', 'Discard recording');
        cancelBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path fill="currentColor" d="M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7a1 1 0 1 0-1.41 1.42L10.59 12l-4.89 4.89a1 1 0 1 0 1.41 1.41L12 13.41l4.89 4.89a1 1 0 0 0 1.41-1.41L13.41 12l4.89-4.88a1 1 0 0 0 0-1.41Z"/>
            </svg>
        `;

        // ----- Recording state -------------------------------------------------
        const MIN_MS = 1000;       // discard anything shorter than 1s
        const MAX_MS = 10 * 60000; // hard safety stop at 10 minutes
        let mediaRecorder = null;
        let activeStream = null;
        let audioChunks = [];
        let startTime = 0;
        let cancelled = false;
        let timerId = null;
        let autoStopId = null;

        function createMediaRecorder(stream) {
            const mimeTypes = [
                'audio/ogg; codecs=opus',
                'audio/webm; codecs=opus',
                'audio/webm',
                '' // let browser choose default
            ];
            for (const mime of mimeTypes) {
                try {
                    if (MediaRecorder.isTypeSupported ? MediaRecorder.isTypeSupported(mime) : true) {
                        log(`Using MediaRecorder mime type: "${mime}"`);
                        return new MediaRecorder(stream, { mimeType: mime });
                    }
                } catch (e) {
                    debug(`MediaRecorder.isTypeSupported("${mime}") threw:`, e);
                }
            }
            log('Falling back to MediaRecorder with no explicit mime type');
            return new MediaRecorder(stream);
        }

        function setRecordingUI(on) {
            voiceBtn.classList.toggle('recording', on);
            cancelBtn.classList.toggle('show', on);
            timerEl.classList.toggle('show', on);
            voiceBtn.title = on ? 'Click to stop and send' : 'Click to record a voice message';
        }

        function tickTimer() {
            const s = Math.floor((performance.now() - startTime) / 1000);
            timerEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        }

        function cleanupRecording() {
            clearInterval(timerId); timerId = null;
            clearTimeout(autoStopId); autoStopId = null;
            if (activeStream) { activeStream.getTracks().forEach(t => t.stop()); activeStream = null; }
            setRecordingUI(false);
        }

        async function startRecording() {
            try {
                activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (err) {
                error('Mic access failed:', err);
                showToast('Could not access microphone.', 'danger');
                return;
            }
            mediaRecorder = createMediaRecorder(activeStream);
            audioChunks = [];
            cancelled = false;
            startTime = performance.now();

            mediaRecorder.ondataavailable = ev => { if (ev.data.size > 0) audioChunks.push(ev.data); };
            mediaRecorder.onstop = async () => {
                const elapsed = performance.now() - startTime;
                cleanupRecording();

                if (cancelled) { log('Recording discarded by user.'); return; }
                if (elapsed < MIN_MS) {
                    showToast('Recording too short — hold a bit longer.', 'warning');
                    return;
                }

                const raw = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
                let outBlob = raw;
                // Firefox already records Ogg; Chrome records WebM -> remux it
                if (!/ogg/i.test(raw.type)) {
                    try {
                        const bytes = new Uint8Array(await raw.arrayBuffer());
                        const ogg = webmOpusToOgg(bytes);
                        outBlob = new Blob([ogg], { type: 'audio/ogg' });
                        log('Remuxed WebM/Opus -> Ogg/Opus (', ogg.length, 'bytes)');
                    } catch (e) {
                        error('Remux failed, sending original WebM:', e);
                    }
                }
                await sendVoiceMessage(outBlob);
            };

            mediaRecorder.start();
            setRecordingUI(true);
            tickTimer();
            timerId = setInterval(tickTimer, 250);
            autoStopId = setTimeout(() => {
                if (mediaRecorder && mediaRecorder.state === 'recording') {
                    showToast('Reached 10 min limit — sending.', 'warning');
                    mediaRecorder.stop();
                }
            }, MAX_MS);
        }

        function finishRecording(send) {
            if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
            cancelled = !send;
            mediaRecorder.stop(); // onstop handles send/discard
        }

        // Click mic: start, or stop-and-send if already recording
        voiceBtn.addEventListener('click', e => {
            e.preventDefault();
            if (mediaRecorder && mediaRecorder.state === 'recording') finishRecording(true);
            else startRecording();
        });

        // Cancel: stop and discard
        cancelBtn.addEventListener('click', e => {
            e.preventDefault();
            finishRecording(false);
        });

        // Append into the chat-bar buttons toolbar (with the gif/emoji buttons)
        container.appendChild(timerEl);
        container.appendChild(cancelBtn);
        container.appendChild(voiceBtn);
        // log('Voice button injected.');
    }

    // -----------------------------------------------------------------------
    // Get channel ID from URL or DOM
    // -----------------------------------------------------------------------
    function getChannelId() {
        // 1️⃣ Try URL pattern: /channels/<guild>/<channel>
        const urlMatch = window.location.pathname.match(/\/channels\/([^\/]+)\/([^\/]+)/);
        if (urlMatch) {
            const channelId = urlMatch[2];
            log('Channel ID from URL:', channelId);
            return channelId;
        }

        // 2️⃣ Look for any element with a channel‑like href (e.g., in the sidebar)
        const chanLink = document.querySelector('a[href^="/channels/"]');
        if (chanLink) {
            const m = chanLink.href.match(/\/channels\/([^\/]+)\/([^\/]+)/);
            if (m) {
                const channelId = m[2];
                log('Channel ID from sidebar link:', channelId);
                return channelId;
            }
        }

        // 3️⃣ Look for elements with data-list-item-id (sometimes used for channel items)
        const item = document.querySelector('[data-list-item-id]');
        if (item) {
            const id = item.getAttribute('data-list-item-id');
            if (id && /^\d+$/.test(id)) {
                log('Channel ID from data-list-item-id:', id);
                return id;
            }
        }

        // 4️⃣ As a last resort, try to read from webpack chunks (not reliable in userscript)
        // We'll skip that for simplicity.

        error('Unable to determine channel ID from URL or DOM.');
        return null;
    }

    // -----------------------------------------------------------------------
    // Send the recorded blob via Discord’s REST API
    // -----------------------------------------------------------------------
    // Decode blob → duration (secs) + waveform byte array Discord wants.
    async function analyzeAudio(blob) {
        try {
            const buf = await blob.arrayBuffer();
            const AC = window.AudioContext || window.webkitAudioContext;
            const ctx = new AC();
            const audio = await ctx.decodeAudioData(buf.slice(0));
            const duration = audio.duration;
            const raw = audio.getChannelData(0);
            // Downsample to ~100 buckets of peak amplitude, scale 0-255
            const buckets = 100;
            const step = Math.floor(raw.length / buckets) || 1;
            const wf = new Uint8Array(buckets);
            for (let i = 0; i < buckets; i++) {
                let peak = 0;
                for (let j = 0; j < step; j++) {
                    const v = Math.abs(raw[i * step + j] || 0);
                    if (v > peak) peak = v;
                }
                wf[i] = Math.min(255, Math.floor(peak * 255));
            }
            ctx.close();
            return { duration, waveform: btoa(String.fromCharCode(...wf)) };
        } catch (e) {
            debug('analyzeAudio failed, using fallback:', e);
            // Fallback: flat waveform, 1s duration
            return { duration: 1, waveform: btoa(String.fromCharCode(...new Uint8Array(100).fill(128))) };
        }
    }

    async function sendVoiceMessage(blob) {
        const channelId = getChannelId();
        if (!channelId) {
            showToast('Unable to determine current channel.', 'danger');
            return;
        }

        const token = getDiscordToken();
        if (!token) {
            error('No Discord token available – cannot send message.');
            showToast('Failed to send voice message: missing auth token.', 'danger');
            return;
        }

        const filename = 'voice-message.ogg';
        const headers = { Authorization: token, 'Content-Type': 'application/json' };

        try {
            const { duration, waveform } = await analyzeAudio(blob);
            log('Audio analyzed – duration:', duration, 'secs');

            // 1) Reserve a cloud upload slot
            const upResp = await fetch(`https://discord.com/api/v9/channels/${channelId}/attachments`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    files: [{ filename, file_size: blob.size, id: '0' }]
                })
            });
            if (!upResp.ok) throw new Error(`attachments ${upResp.status}: ${await upResp.text()}`);
            const { attachments } = await upResp.json();
            const slot = attachments[0];
            log('Got upload slot:', slot.upload_filename);

            // 2) PUT the audio to the signed GCP URL (no auth header here)
            const putResp = await fetch(slot.upload_url, {
                method: 'PUT',
                headers: { 'Content-Type': 'audio/ogg' },
                body: blob
            });
            if (!putResp.ok) throw new Error(`upload PUT ${putResp.status}: ${await putResp.text()}`);
            log('Audio uploaded to cloud.');

            // 3) Post the message referencing the uploaded file
            const msgResp = await fetch(`https://discord.com/api/v9/channels/${channelId}/messages`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    content: '',
                    flags: 8192, // MessageFlags.IS_VOICE_MESSAGE
                    attachments: [{
                        id: '0',
                        filename,
                        uploaded_filename: slot.upload_filename,
                        duration_secs: duration,
                        waveform
                    }]
                })
            });
            if (!msgResp.ok) throw new Error(`messages ${msgResp.status}: ${await msgResp.text()}`);

            log('Voice message sent.');
            showToast('Voice message sent!', 'success');
        } catch (err) {
            error('Send failed:', err);
            showToast('Failed to send voice message: ' + err.message, 'danger');
        }
    }

    // -----------------------------------------------------------------------
    // Observe DOM changes – Discord updates the input bar dynamically
    // -----------------------------------------------------------------------
    const observer = new MutationObserver(() => {
        const container = findButtonsContainer();
        if (container) injectVoiceButton(container);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Initial run in case the UI is already rendered
    log('Running initial buttons container search...');
    const initialContainer = findButtonsContainer();
    if (initialContainer) injectVoiceButton(initialContainer);
    else log('Initial buttons container not found – will rely on MutationObserver.');

    window.getDiscordToken = getDiscordToken; // expose for debugging
})();
