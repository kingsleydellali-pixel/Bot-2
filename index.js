// ============================================================
//  KING-XD Bot v10 — index.js
//  WhatsApp Multi-Device Bot with Embedded Web Dashboard
//  Built for Render.com | Node.js 20+
// ============================================================

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  downloadContentFromMessage
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const pino = require('pino');
const QRCode = require('qrcode');
const NodeCache = require('node-cache');
const sharp = require('sharp');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const settings = require('./settings');
const autoreply = require('./autoreply');

// ─────────────────────────────────────────────
//  GLOBAL STATE
// ─────────────────────────────────────────────
const logger = pino({ level: 'silent' });
const groupCache = new NodeCache({ stdTTL: 300, useClones: false });
const messageStore = new Map();       // anti-delete cache
const deletedMessages = new Map();    // recovered messages
const processedViewOnce = new Set();  // view-once dedup
const startTime = Date.now();

let sock = null;
let connectionState = 'disconnected';
let currentQR = null;
let currentPairingCode = null;
let pairingRequested = false;
let fakeProgressInterval = null;
let fakeProgressValue = 0;
let pairingNumber = '';

// ─────────────────────────────────────────────
//  EXPRESS WEB DASHBOARD (EMBEDDED)
// ─────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Simple in-memory rate limiter
const rateMap = new Map();
function rateLimit(ip, max = 5, windowMs = 60000) {
  const now = Date.now();
  const record = rateMap.get(ip) || { count: 0, reset: now + windowMs };
  if (now > record.reset) { record.count = 0; record.reset = now + windowMs; }
  record.count++;
  rateMap.set(ip, record);
  return record.count <= max;
}

// ── Dashboard HTML ──
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>KING-XD Bot v10 — Pairing Dashboard</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; font-family:'Segoe UI',Roboto,sans-serif; }
  body {
    min-height:100vh;
    display:flex; align-items:center; justify-content:center;
    background:url('https://files.catbox.moe/mkwqsk.jpeg') center/cover no-repeat fixed;
    position:relative;
  }
  body::before {
    content:''; position:fixed; inset:0;
    backdrop-filter:blur(12px) brightness(0.55);
    background:rgba(10,10,25,0.45);
    z-index:0;
  }
  .card {
    position:relative; z-index:1;
    width:min(480px, 94vw);
    background:rgba(18,18,35,0.78);
    border:1px solid rgba(120,80,255,0.35);
    border-radius:22px;
    padding:38px 30px 34px;
    box-shadow:0 20px 60px rgba(0,0,0,0.55), 0 0 60px rgba(100,60,255,0.12);
    text-align:center;
    color:#eaeaf5;
  }
  .logo {
    width:78px; height:78px; border-radius:50%;
    background:linear-gradient(135deg,#6c3bff,#a855f7,#ec4899);
    display:flex; align-items:center; justify-content:center;
    margin:0 auto 16px; font-size:34px;
    box-shadow:0 0 30px rgba(168,85,247,0.5);
  }
  h1 { font-size:1.55rem; font-weight:700; letter-spacing:0.5px; margin-bottom:4px; }
  .sub { font-size:0.83rem; color:#9b96c5; margin-bottom:22px; letter-spacing:0.3px; }
  .status-badge {
    display:inline-flex; align-items:center; gap:7px;
    padding:6px 14px; border-radius:99px; font-size:0.78rem;
    background:rgba(255,255,255,0.07); border:1px solid rgba(255,255,255,0.12);
    margin-bottom:22px;
  }
  .dot { width:9px; height:9px; border-radius:50%; background:#f43f5e; }
  .dot.green { background:#22c55e; box-shadow:0 0 8px #22c55e; }
  input[type=tel] {
    width:100%; padding:14px 16px; border-radius:12px;
    border:1px solid rgba(255,255,255,0.15);
    background:rgba(255,255,255,0.06); color:#fff;
    font-size:1rem; outline:none; margin-bottom:14px;
    transition:border 0.25s;
  }
  input[type=tel]:focus { border-color:#a855f7; }
  input::placeholder { color:#6b6690; }
  button {
    width:100%; padding:14px; border:none; border-radius:12px;
    font-size:1rem; font-weight:600; cursor:pointer;
    background:linear-gradient(135deg,#6c3bff,#a855f7,#ec4899);
    color:#fff; letter-spacing:0.4px;
    transition:transform 0.15s, box-shadow 0.25s;
    box-shadow:0 6px 24px rgba(108,59,255,0.35);
  }
  button:hover { transform:translateY(-2px); box-shadow:0 10px 32px rgba(108,59,255,0.5); }
  button:disabled { opacity:0.55; cursor:not-allowed; transform:none; }
  .pair-code {
    font-size:2.1rem; font-weight:800; letter-spacing:6px;
    color:#c4b5fd; margin:18px 0 6px; font-family:monospace;
    text-shadow:0 0 20px rgba(168,85,247,0.6);
  }
  .hint { font-size:0.82rem; color:#9b96c5; margin-bottom:12px; line-height:1.5; }
  .qr-box { margin:16px auto; background:#fff; padding:10px; border-radius:14px; width:fit-content; }
  .qr-box img { display:block; width:200px; height:200px; }
  .progress-wrap { margin:18px 0 8px; }
  .progress-bar {
    height:10px; border-radius:99px; background:rgba(255,255,255,0.08);
    overflow:hidden; margin-bottom:6px;
  }
  .progress-fill {
    height:100%; width:0%; border-radius:99px;
    background:linear-gradient(90deg,#6c3bff,#ec4899);
    transition:width 0.4s ease;
  }
  .progress-text { font-size:0.78rem; color:#9b96c5; }
  .hidden { display:none !important; }
  .toast {
    position:fixed; top:22px; right:22px; z-index:99;
    background:rgba(34,197,94,0.92); color:#fff;
    padding:12px 22px; border-radius:12px; font-size:0.9rem;
    box-shadow:0 10px 30px rgba(0,0,0,0.4);
    animation:slideIn 0.4s ease;
  }
  @keyframes slideIn { from{transform:translateX(120%);opacity:0} to{transform:translateX(0);opacity:1} }
  .footer { margin-top:20px; font-size:0.72rem; color:#6b6690; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">🤖</div>
  <h1>KING-XD Bot</h1>
  <p class="sub">v10.0.0 — Multi-Device Pairing</p>
  <div class="status-badge"><span class="dot" id="statusDot"></span><span id="statusText">Disconnected</span></div>

  <div id="sectionInput">
    <input type="tel" id="phoneInput" placeholder="255712345678 (country code + number)">
    <button id="pairBtn">Generate Pairing Code</button>
  </div>

  <div id="sectionProgress" class="hidden">
    <div class="progress-wrap">
      <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
      <div class="progress-text" id="progressText">Optimising connection…</div>
    </div>
  </div>

  <div id="sectionCode" class="hidden">
    <div class="pair-code" id="pairCode">--------</div>
    <p class="hint">Enter this code in WhatsApp → Linked Devices → Link with phone number.</p>
  </div>

  <div id="sectionQR" class="hidden">
    <p class="hint">Or scan this QR code:</p>
    <div class="qr-box"><img id="qrImg" src="" alt="QR"></div>
  </div>

  <p class="footer">Developed by ᴋɪɴɢsʟᴇʏ-xᴍᴅ ᴛᴇᴄʜ • Powered by Baileys</p>
</div>

<script>
const $ = id => document.getElementById(id);
let pollTimer = null;

async function fetchStatus() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    updateStatusUI(d.state);
  } catch(e) {}
}

function updateStatusUI(state) {
  const dot = $('statusDot'), txt = $('statusText');
  if (state === 'connected') {
    dot.className = 'dot green'; txt.textContent = 'Connected';
    $('sectionInput').classList.add('hidden');
    $('sectionProgress').classList.add('hidden');
    $('sectionCode').classList.add('hidden');
    $('sectionQR').classList.add('hidden');
  } else if (state === 'pairing') {
    dot.className = 'dot'; txt.textContent = 'Pairing…';
  } else {
    dot.className = 'dot'; txt.textContent = 'Disconnected';
  }
}

$('pairBtn').addEventListener('click', async () => {
  const phone = $('phoneInput').value.trim().replace(/[^0-9]/g,'');
  if (!phone || phone.length < 10) { alert('Enter a valid number with country code (no +).'); return; }
  $('pairBtn').disabled = true;
  $('sectionInput').classList.add('hidden');
  $('sectionProgress').classList.remove('hidden');

  // Start fake progress
  let p = 0;
  const iv = setInterval(() => {
    p += Math.random() * 4 + 0.8;
    if (p > 100) p = 100;
    $('progressFill').style.width = p + '%';
    const mb = (p / 100 * 47.3).toFixed(1);
    $('progressText').textContent = p < 100
      ? 'Optimising connection… ' + mb + ' MB'
      : 'Finalising…';
    if (p >= 100) clearInterval(iv);
  }, 280);

  try {
    const r = await fetch('/api/pair', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ phone })
    });
    const d = await r.json();
    if (d.success) {
      clearInterval(iv);
      $('progressFill').style.width = '100%';
      setTimeout(() => {
        $('sectionProgress').classList.add('hidden');
        $('sectionCode').classList.remove('hidden');
        $('pairCode').textContent = d.code;
        if (d.qr) {
          $('sectionQR').classList.remove('hidden');
          $('qrImg').src = d.qr;
        }
      }, 900);
    } else {
      clearInterval(iv);
      $('sectionProgress').classList.add('hidden');
      $('sectionInput').classList.remove('hidden');
      $('pairBtn').disabled = false;
      alert('Error: ' + (d.error || 'Unknown'));
    }
  } catch(e) {
    clearInterval(iv);
    $('sectionProgress').classList.add('hidden');
    $('sectionInput').classList.remove('hidden');
    $('pairBtn').disabled = false;
    alert('Network error. Please try again.');
  }
});

// Poll status every 4 s
pollTimer = setInterval(async () => {
  await fetchStatus();
  const r = await fetch('/api/qr');
  const d = await r.json();
  if (d.qr && !$('sectionCode').classList.contains('hidden') === false) {
    // show QR if available and we're not already connected
    if (d.state !== 'connected' && d.qr) {
      $('sectionQR').classList.remove('hidden');
      $('qrImg').src = d.qr;
    }
  }
}, 4000);
fetchStatus();
</script>
</body>
</html>`;

// ── API Routes ──
app.get('/', (req, res) => res.send(DASHBOARD_HTML));

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), connection: connectionState }));

app.get('/api/status', (req, res) => {
  res.json({ state: connectionState, pairing: pairingRequested });
});

app.get('/api/qr', (req, res) => {
  res.json({ qr: currentQR, state: connectionState });
});

app.post('/api/pair', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!rateLimit(ip)) return res.status(429).json({ error: 'Too many requests. Wait a minute.' });

  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });

  const clean = phone.replace(/[^0-9]/g, '');
  if (clean.length < 10) return res.status(400).json({ error: 'Invalid number' });

  try {
    pairingNumber = clean;
    pairingRequested = true;

    // Reset socket for fresh pairing
    if (sock) { try { sock.end(undefined); } catch(e){} sock = null; }

    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      cachedGroupMetadata: async (jid) => groupCache.get(jid),
      generateHighQualityLinkPreview: true
    });

    sock.ev.on('creds.update', saveCreds);

    // Wait a moment for socket to initialise
    await new Promise(r => setTimeout(r, 2500));

    const code = await sock.requestPairingCode(clean);
    currentPairingCode = code;
    connectionState = 'pairing';

    // Also capture QR as fallback
    let qrDataUrl = null;
    try {
      qrDataUrl = await QRCode.toDataURL('https://wa.me/' + clean);
    } catch(e) {}

    // Attach the full event handler
    attachSocketHandlers(sock, state, saveCreds);

    return res.json({ success: true, code, qr: qrDataUrl });
  } catch (err) {
    console.error('Pair error:', err);
    connectionState = 'disconnected';
    return res.status(500).json({ error: err.message || 'Pairing failed' });
  }
});

// ─────────────────────────────────────────────
//  SOCKET HANDLERS (CONNECTION, MESSAGES, ETC.)
// ─────────────────────────────────────────────
function attachSocketHandlers(sockInstance, state, saveCreds) {

  // ── Connection updates ──
  sockInstance.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      QRCode.toDataURL(qr).then(url => { currentQR = url; }).catch(() => {});
    }

    if (connection === 'open') {
      connectionState = 'connected';
      pairingRequested = false;
      currentPairingCode = null;
      currentQR = null;
      console.log('✅ Bot connected successfully.');
      // Auto-join channel & auto-react
      joinAndReactChannel(sockInstance);
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      connectionState = 'disconnected';
      if (code === DisconnectReason.loggedOut) {
        console.log('❌ Logged out. Delete ./auth_info and restart.');
      } else {
        console.log('🔄 Reconnecting…');
        setTimeout(() => startBot(), 3000);
      }
    }
  });

  // ── Messages ──
  sockInstance.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try { await handleIncomingMessage(sockInstance, msg); } catch(e) { console.error('Msg handler error:', e); }
    }
  });

  // ── Anti-delete ──
  sockInstance.ev.on('messages.update', async (updates) => {
    if (!settings.antiDelete) return;
    for (const { key, update } of updates) {
      if (update.message === null || update.messageStubType === 0) {
        // Message revoked
        const cached = messageStore.get(key.id);
        if (cached) {
          deletedMessages.set(key.id, cached);
          try {
            const jid = key.remoteJid;
            await sockInstance.sendMessage(jid, {
              text: `🚫 *ANTI-DELETE*\n\n*From:* @${key.participant?.split('@')[0] || 'Unknown'}\n*Deleted message:*\n${cached.text || '[media]'}`,
              mentions: key.participant ? [key.participant] : []
            });
            if (cached.media) {
              await sockInstance.sendMessage(jid, cached.media);
            }
          } catch(e) {}
        }
      }
    }
  });

  // ── View-once capture ──
  sockInstance.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.message?.viewOnceMessageV2) {
        const content = msg.message.viewOnceMessageV2.message;
        if (content?.imageMessage || content?.videoMessage) {
          const id = msg.key.id;
          if (!processedViewOnce.has(id)) {
            processedViewOnce.add(id);
            try {
              const buffer = await downloadContentFromMessage(
                content.imageMessage || content.videoMessage, 'image'
              );
              let buf = Buffer.from([]);
              for await (const chunk of buffer) buf = Buffer.concat([buf, chunk]);
              await sockInstance.sendMessage(msg.key.remoteJid, {
                image: buf,
                caption: '👁️ *View-Once captured*'
              });
            } catch(e) {}
          }
        }
      }
    }
  });

  // ── Anti-call ──
  sockInstance.ev.on('call', async (calls) => {
    if (!settings.antiCall) return;
    for (const call of calls) {
      if (call.status === 'offer') {
        try {
          await sockInstance.rejectCall(call.id, call.from);
          await sockInstance.sendMessage(call.from, { text: '📵 *Calls are not allowed.*' });
        } catch(e) {}
      }
    }
  });
}

// ─────────────────────────────────────────────
//  MESSAGE HANDLER
// ─────────────────────────────────────────────
async function handleIncomingMessage(sockInstance, msg) {
  const from = msg.key.remoteJid;
  const isGroup = from.endsWith('@g.us');
  const sender = isGroup ? msg.key.participant : from;
  const text = msg.message?.conversation ||
               msg.message?.extendedTextMessage?.text ||
               msg.message?.imageMessage?.caption ||
               msg.message?.videoMessage?.caption || '';
  const pushName = msg.pushName || 'User';

  if (!text) return;

  // ── Cache for anti-delete ──
  if (settings.antiDelete && !msg.key.fromMe) {
    messageStore.set(msg.key.id, {
      text,
      media: msg.message?.imageMessage || msg.message?.videoMessage ? msg.message : null,
      sender: sender,
      timestamp: Date.now()
    });
    // Clean cache older than 2 h
    if (messageStore.size > 500) {
      const cutoff = Date.now() - 7200000;
      for (const [k, v] of messageStore) if (v.timestamp < cutoff) messageStore.delete(k);
    }
  }

  // ── Anti-link ──
  if (settings.antiLink && isGroup && !msg.key.fromMe) {
    const linkRegex = /(https?:\/\/[^\s]+)|(wa\.me\/[^\s]+)|(chat\.whatsapp\.com\/[^\s]+)/gi;
    if (linkRegex.test(text)) {
      const meta = await sockInstance.groupMetadata(from).catch(() => null);
      const isAdmin = meta?.participants?.find(p => p.id === sender)?.admin;
      if (!isAdmin) {
        await sockInstance.sendMessage(from, { delete: msg.key });
        await sockInstance.groupParticipantsUpdate(from, [sender], 'remove');
        await sockInstance.sendMessage(from, { text: `🚫 @${sender.split('@')[0]} removed for sharing a link.`, mentions: [sender] });
        return;
      }
    }
  }

  // ── Auto-react ──
  if (settings.autoReact && !msg.key.fromMe) {
    try {
      const emoji = settings.reactEmojis[Math.floor(Math.random() * settings.reactEmojis.length)];
      await sockInstance.sendMessage(from, { react: { text: emoji, key: msg.key } });
    } catch(e) {}
  }

  // ── Auto-status view ──
  if (settings.autoStatus && from === 'status@broadcast') {
    try { await sockInstance.readMessages([msg.key]); } catch(e) {}
  }

  // ── Auto-reply (knowledge base) ──
  if (settings.autoReply && !msg.key.fromMe) {
    const lower = text.toLowerCase().trim();
    if (autoreply[lower]) {
      const reply = typeof autoreply[lower] === 'function' ? autoreply[lower]() : autoreply[lower];
      await sockInstance.sendMessage(from, { text: reply }, { quoted: msg });
      return;
    }
  }

  // ── Command parser ──
  if (!text.startsWith(settings.prefix)) return;
  const args = text.slice(settings.prefix.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();
  const body = args.join(' ');

  try {
    await handleCommand(sockInstance, { from, sender, isGroup, msg, pushName, command, args, body });
  } catch(e) {
    await sockInstance.sendMessage(from, { text: `⚠️ Error: ${e.message}` });
  }
}

// ─────────────────────────────────────────────
//  COMMAND DISPATCHER
// ─────────────────────────────────────────────
async function handleCommand(sockInstance, ctx) {
  const { from, sender, isGroup, msg, pushName, command, args, body } = ctx;
  const isOwner = sender?.includes(settings.ownerNumber);

  const reply = (t) => sockInstance.sendMessage(from, { text: t }, { quoted: msg });

  switch (command) {

    // ═══ STATUS ═══
    case 'menu':
    case 'help': {
      const uptime = formatUptime(Date.now() - startTime);
      const menu = `
╭━〔${settings.botName}〕━⬣
┃ [] STATUS  : ${connectionState === 'connected' ? 'ONLINE' : 'OFFLINE'}
┃ [] RUNTIME : ${uptime}
┃ [] USER    : ${pushName}
┃ [] DEV     : ${settings.developer}
╰━━━━━━━━━━━━━━━━━━━━⬣

╭━━〔 📥 DOWNLOADS 〕━━⬣
┃➤ .yt <url>
┃➤ .song <url>
┃➤ .video <query>
┃➤ .tt <url>
┃➤ .ig <url>
┃➤ .fb <url>
┃➤ .wallpaper <query>
╰━━━━━━━━━━━━━━━━━━━━⬣

╭━━〔 🔎 SEARCH 〕━━⬣
┃➤ .google <query>
┃➤ .wiki <query>
┃➤ .weather <city>
┃➤ .yts <query>
╰━━━━━━━━━━━━━━━━━━━━⬣

╭━━〔 🎨 MEDIA TOOLS 〕━━⬣
┃➤ .sticker (reply to image)
┃➤ .toimg (reply to sticker)
┃➤ .compress (reply to image)
┃➤ .blur (reply to image)
┃➤ .removebg (reply to image)
╰━━━━━━━━━━━━━━━━━━━━⬣

╭━━〔 👑 GROUP MANAGER 〕━━⬣
┃➤ .gcstatus
┃➤ .groupinfo
┃➤ .kick @user
┃➤ .promote @user
┃➤ .demote @user
┃➤ .add <number>
┃➤ .mute / .unmute
┃➤ .link
┃➤ .revoke
┃➤ .tag <text>
┃➤ .tagall
┃➤ .kickall
┃➤ .vv (reply to view-once)
╰━━━━━━━━━━━━━━━━━━━━⬣

╭━━〔 🛠 TOOLS 〕━━⬣
┃➤ .calc <expr>
┃➤ .flip
┃➤ .roll
┃➤ .8ball <question>
┃➤ .joke
┃➤ .quote
┃➤ .fact
┃➤ .reverse <text>
┃➤ .upper <text>
┃➤ .lower <text>
┃➤ .id
┃➤ .whoami
┃➤ .ping
┃➤ .alive
┃➤ .uptime
╰━━━━━━━━━━━━━━━━━━━━⬣

╭━━〔 👑 OWNER 〕━━⬣
┃➤ .broadcast <text>
┃➤ .restart
┃➤ .block @user
┃➤ .unblock @user
╰━━━━━━━━━━━━━━━━━━━━⬣

╭━━〔 ⚙️ SETTINGS 〕━━⬣
┃➤ .autoreact on/off
┃➤ .autostatus on/off
┃➤ .antilink on/off
┃➤ .antidelete on/off
┃➤ .anticall on/off
┃➤ .mode <public|private>
┃➤ .settings
┃➤ .autoreply on/off
╰━━━━━━━━━━━━━━━━━━━━⬣`;
      return sockInstance.sendMessage(from, { image: { url: settings.botImage }, caption: menu }, { quoted: msg });
    }

    // ═══ DOWNLOADERS ═══
    case 'yt':
    case 'song':
    case 'video': {
      const url = body || args[0];
      if (!url) return reply('❌ Provide a YouTube URL or search query.');
      await reply('⏳ Downloading… this may take a moment.');
      try {
        const isAudio = command === 'song';
        const out = await ytDlpDownload(url, isAudio);
        if (out.error) return reply(`❌ ${out.error}`);
        if (isAudio) {
          await sockInstance.sendMessage(from, { audio: { url: out.file }, mimetype: 'audio/mp4', ptt: false }, { quoted: msg });
        } else {
          await sockInstance.sendMessage(from, { video: { url: out.file }, caption: out.title || 'Here is your video 🎬' }, { quoted: msg });
        }
      } catch(e) { reply('❌ Download failed: ' + e.message); }
      break;
    }

    case 'tt':
    case 'ig':
    case 'fb': {
      const url = body || args[0];
      if (!url) return reply('❌ Provide a URL.');
      await reply('⏳ Fetching media…');
      try {
        const out = await ytDlpDownload(url, false);
        if (out.error) return reply(`❌ ${out.error}`);
        await sockInstance.sendMessage(from, { video: { url: out.file }, caption: `✅ Downloaded from ${command.toUpperCase()}` }, { quoted: msg });
      } catch(e) { reply('❌ Failed: ' + e.message); }
      break;
    }

    case 'yts': {
      if (!body) return reply('❌ Provide a search query.');
      await reply(`🔎 Searching YouTube for: *${body}*…`);
      try {
        const results = await ytSearch(body);
        let txt = `🔎 *YouTube Results for:* ${body}\n\n`;
        results.slice(0, 5).forEach((r, i) => {
          txt += `*${i+1}.* ${r.title}\n   ⏱ ${r.duration || 'N/A'}\n   🔗 ${r.url}\n\n`;
        });
        reply(txt);
      } catch(e) { reply('❌ Search failed.'); }
      break;
    }

    case 'wallpaper': {
      if (!body) return reply('❌ Provide a search term.');
      await reply(`🖼️ Searching wallpapers for *${body}*…`);
      try {
        const imgUrl = `https://source.unsplash.com/1080x1920/?${encodeURIComponent(body)}`;
        await sockInstance.sendMessage(from, { image: { url: imgUrl }, caption: `🖼️ Wallpaper: ${body}` }, { quoted: msg });
      } catch(e) { reply('❌ Could not fetch wallpaper.'); }
      break;
    }

    // ═══ SEARCH ═══
    case 'google': {
      if (!body) return reply('❌ Provide a search query.');
      await reply(`🔎 *Google:* https://www.google.com/search?q=${encodeURIComponent(body)}`);
      break;
    }

    case 'wiki': {
      if (!body) return reply('❌ Provide a search term.');
      try {
        const { data } = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(body)}`);
        reply(`📖 *${data.title}*\n\n${data.extract || 'No summary available.'}\n\n🔗 ${data.content_urls?.desktop?.page || ''}`);
      } catch(e) { reply('❌ Wikipedia lookup failed.'); }
      break;
    }

    case 'weather': {
      if (!body) return reply('❌ Provide a city name.');
      try {
        const { data } = await axios.get(`https://wttr.in/${encodeURIComponent(body)}?format=j1`);
        const c = data.current_condition[0];
        reply(`🌤️ *Weather in ${body}*\n\n🌡️ Temp: ${c.temp_C}°C (feels ${c.FeelsLikeC}°C)\n☁️ ${c.weatherDesc[0].value}\n💧 Humidity: ${c.humidity}%\n💨 Wind: ${c.windspeedKmph} km/h`);
      } catch(e) { reply('❌ Weather lookup failed.'); }
      break;
    }

    // ═══ MEDIA TOOLS ═══
    case 'sticker': {
      if (!msg.message?.imageMessage && !msg.message?.videoMessage) return reply('❌ Reply to an image or video with .sticker');
      await reply('🎨 Creating sticker…');
      try {
        const media = msg.message.imageMessage || msg.message.videoMessage;
        const stream = await downloadContentFromMessage(media, 'image');
        let buf = Buffer.from([]);
        for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
        const webp = await sharp(buf).resize(512, 512, { fit: 'inside' }).webp().toBuffer();
        await sockInstance.sendMessage(from, { sticker: webp }, { quoted: msg });
      } catch(e) { reply('❌ Sticker creation failed.'); }
      break;
    }

    case 'toimg': {
      if (!msg.message?.stickerMessage) return reply('❌ Reply to a sticker with .toimg');
      try {
        const stream = await downloadContentFromMessage(msg.message.stickerMessage, 'sticker');
        let buf = Buffer.from([]);
        for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
        const png = await sharp(buf).png().toBuffer();
        await sockInstance.sendMessage(from, { image: png, caption: '🖼️ Converted from sticker' }, { quoted: msg });
      } catch(e) { reply('❌ Conversion failed.'); }
      break;
    }

    case 'blur': {
      if (!msg.message?.imageMessage) return reply('❌ Reply to an image with .blur');
      try {
        const stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
        let buf = Buffer.from([]);
        for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
        const blurred = await sharp(buf).blur(12).toBuffer();
        await sockInstance.sendMessage(from, { image: blurred, caption: '🌫️ Blurred' }, { quoted: msg });
      } catch(e) { reply('❌ Blur failed.'); }
      break;
    }

    case 'compress': {
      if (!msg.message?.imageMessage) return reply('❌ Reply to an image with .compress');
      try {
        const stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
        let buf = Buffer.from([]);
        for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
        const compressed = await sharp(buf).jpeg({ quality: 40 }).toBuffer();
        await sockInstance.sendMessage(from, { image: compressed, caption: '📦 Compressed (40 %)' }, { quoted: msg });
      } catch(e) { reply('❌ Compression failed.'); }
      break;
    }

    case 'removebg': {
      if (!msg.message?.imageMessage) return reply('❌ Reply to an image with .removebg');
      await reply('🪄 Removing background… (this needs an external API; returning original)');
      break;
    }

    // ═══ GROUP MANAGER ═══
    case 'gcstatus':
    case 'groupinfo': {
      if (!isGroup) return reply('❌ Group-only command.');
      try {
        const meta = await sockInstance.groupMetadata(from);
        const admins = meta.participants.filter(p => p.admin).map(p => `@${p.id.split('@')[0]}`).join(', ');
        const txt = `📋 *Group Info*\n\n📛 Name: ${meta.subject}\n🆔 JID: ${meta.id}\n👥 Members: ${meta.participants.length}\n👑 Admins: ${admins}\n📅 Created: ${new Date(meta.creation * 1000).toLocaleString()}\n📝 Desc: ${meta.desc || 'None'}`;
        sockInstance.sendMessage(from, { text: txt, mentions: meta.participants.filter(p => p.admin).map(p => p.id) });
      } catch(e) { reply('❌ Could not fetch group info.'); }
      break;
    }

    case 'kick':
    case 'promote':
    case 'demote': {
      if (!isGroup) return reply('❌ Group-only command.');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      if (!mentioned.length) return reply(`❌ Mention a user to ${command}.`);
      const action = command === 'kick' ? 'remove' : command;
      try {
        await sockInstance.groupParticipantsUpdate(from, mentioned, action);
        reply(`✅ ${command} successful for ${mentioned.map(j => '@' + j.split('@')[0]).join(', ')}`);
      } catch(e) { reply('❌ Action failed: ' + e.message); }
      break;
    }

    case 'add': {
      if (!isGroup) return reply('❌ Group-only command.');
      if (!body) return reply('❌ Provide a phone number.');
      const num = body.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
      try {
        await sockInstance.groupParticipantsUpdate(from, [num], 'add');
        reply('✅ User added.');
      } catch(e) { reply('❌ Could not add user.'); }
      break;
    }

    case 'mute':
    case 'unmute': {
      if (!isGroup) return reply('❌ Group-only command.');
      const setting = command === 'mute' ? 'announcement' : 'not_announcement';
      try {
        await sockInstance.groupSettingUpdate(from, setting);
        reply(`✅ Group ${command}d.`);
      } catch(e) { reply('❌ Failed.'); }
      break;
    }

    case 'link': {
      if (!isGroup) return reply('❌ Group-only command.');
      try {
        const code = await sockInstance.groupInviteCode(from);
        reply(`🔗 https://chat.whatsapp.com/${code}`);
      } catch(e) { reply('❌ Could not get link.'); }
      break;
    }

    case 'revoke': {
      if (!isGroup) return reply('❌ Group-only command.');
      try {
        await sockInstance.groupRevokeInvite(from);
        reply('✅ Invite link revoked.');
      } catch(e) { reply('❌ Failed.'); }
      break;
    }

    case 'tag':
    case 'tagall': {
      if (!isGroup) return reply('❌ Group-only command.');
      try {
        const meta = await sockInstance.groupMetadata(from);
        const mentions = meta.participants.map(p => p.id);
        const txt = body || '📢 Attention everyone!';
        await sockInstance.sendMessage(from, { text: `${txt}\n\n${mentions.map(j => '@' + j.split('@')[0]).join(' ')}`, mentions });
      } catch(e) { reply('❌ Tag failed.'); }
      break;
    }

    case 'kickall': {
      if (!isGroup) return reply('❌ Group-only command.');
      if (!isOwner) return reply('🔒 Owner-only.');
      try {
        const meta = await sockInstance.groupMetadata(from);
        const nonAdmins = meta.participants.filter(p => !p.admin && p.id !== sender).map(p => p.id);
        if (!nonAdmins.length) return reply('No non-admins to remove.');
        await sockInstance.groupParticipantsUpdate(from, nonAdmins, 'remove');
        reply(`✅ Removed ${nonAdmins.length} members.`);
      } catch(e) { reply('❌ Kickall failed.'); }
      break;
    }

    case 'vv': {
      if (!msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.viewOnceMessageV2) return reply('❌ Reply to a view-once message.');
      try {
        const q = msg.message.extendedTextMessage.contextInfo.quotedMessage.viewOnceMessageV2.message;
        const type = q.imageMessage ? 'image' : q.videoMessage ? 'video' : null;
        if (!type) return reply('❌ Unsupported view-once type.');
        const stream = await downloadContentFromMessage(q[type + 'Message'], type);
        let buf = Buffer.from([]);
        for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
        await sockInstance.sendMessage(from, { [type]: buf, caption: '👁️ View-once revealed' }, { quoted: msg });
      } catch(e) { reply('❌ Could not reveal.'); }
      break;
    }

    // ═══ TOOLS ═══
    case 'calc': {
      if (!body) return reply('❌ Provide an expression, e.g. .calc 2+2*5');
      try {
        const result = Function('"use strict";return (' + body.replace(/[^0-9+\-*/().% ]/g, '') + ')')();
        reply(`🧮 ${body} = *${result}*`);
      } catch(e) { reply('❌ Invalid expression.'); }
      break;
    }

    case 'flip':
      reply(Math.random() < 0.5 ? '🪙 Heads!' : '🪙 Tails!');
      break;

    case 'roll':
      reply(`🎲 You rolled: *${Math.floor(Math.random() * 6) + 1}*`);
      break;

    case '8ball': {
      if (!body) return reply('❌ Ask a question.');
      const answers = ['Yes ✅','No ❌','Maybe 🤔','Definitely 💯','Ask again later ⏳','Absolutely! 🎉','I wouldn\'t count on it 😬','Outlook good 🌟'];
      reply(`🎱 ${answers[Math.floor(Math.random() * answers.length)]}`);
      break;
    }

    case 'joke': {
      const jokes = [
        'Why don\'t scientists trust atoms? Because they make up everything! ⚛️',
        'What do you call a fake noodle? An impasta! 🍝',
        'Why did the scarecrow win an award? He was outstanding in his field! 🌾'
      ];
      reply('😂 ' + jokes[Math.floor(Math.random() * jokes.length)]);
      break;
    }

    case 'quote': {
      const quotes = [
        '“The only way to do great work is to love what you do.” — Steve Jobs',
        '“In the middle of difficulty lies opportunity.” — Albert Einstein',
        '“It does not matter how slowly you go as long as you do not stop.” — Confucius'
      ];
      reply('💬 ' + quotes[Math.floor(Math.random() * quotes.length)]);
      break;
    }

    case 'fact': {
      const facts = [
        '🐙 Octopuses have three hearts.',
        '🍯 Honey never spoils.',
        '🦅 The peregrine falcon is the fastest animal on Earth.'
      ];
      reply('📚 ' + facts[Math.floor(Math.random() * facts.length)]);
      break;
    }

    case 'reverse':
      if (!body) return reply('❌ Provide text.');
      reply('🔄 ' + body.split('').reverse().join(''));
      break;

    case 'upper':
      if (!body) return reply('❌ Provide text.');
      reply(body.toUpperCase());
      break;

    case 'lower':
      if (!body) return reply('❌ Provide text.');
      reply(body.toLowerCase());
      break;

    case 'id':
    case 'whoami':
      reply(`🆔 Your JID: \`${sender}\`\n📛 Name: ${pushName}`);
      break;

    case 'ping': {
      const t = Date.now();
      const sent = await reply('🏓 Pinging…');
      const latency = Date.now() - t;
      await sockInstance.sendMessage(from, { text: `🏓 Pong! Latency: *${latency} ms*` }, { quoted: sent });
      break;
    }

    case 'alive':
      reply('✅ *KING-XD Bot is alive and kicking!*');
      break;

    case 'uptime':
      reply(`⏱️ Uptime: *${formatUptime(Date.now() - startTime)}*`);
      break;

    // ═══ OWNER ═══
    case 'broadcast': {
      if (!isOwner) return reply('🔒 Owner-only.');
      if (!body) return reply('❌ Provide a message to broadcast.');
      const groups = await sockInstance.groupFetchAllParticipating();
      let sent = 0;
      for (const jid of Object.keys(groups)) {
        try { await sockInstance.sendMessage(jid, { text: `📢 *BROADCAST*\n\n${body}` }); sent++; } catch(e) {}
      }
      reply(`✅ Broadcast sent to ${sent} groups.`);
      break;
    }

    case 'restart': {
      if (!isOwner) return reply('🔒 Owner-only.');
      await reply('🔄 Restarting…');
      process.exit(0);
    }

    case 'block':
    case 'unblock': {
      if (!isOwner) return reply('🔒 Owner-only.');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      if (!mentioned.length) return reply('❌ Mention a user.');
      await sockInstance.updateBlockStatus(mentioned[0], command === 'block' ? 'block' : 'unblock');
      reply(`✅ ${command}ed @${mentioned[0].split('@')[0]}`);
      break;
    }

    // ═══ SETTINGS ═══
    case 'autoreact':
    case 'autostatus':
    case 'antilink':
    case 'antidelete':
    case 'anticall':
    case 'autoreply': {
      if (!isOwner) return reply('🔒 Owner-only.');
      const val = args[0]?.toLowerCase();
      if (val !== 'on' && val !== 'off') return reply(`Usage: .${command} on|off`);
      const key = command === 'autostatus' ? 'autoStatus' :
                  command === 'autoreact' ? 'autoReact' :
                  command === 'antilink' ? 'antiLink' :
                  command === 'antidelete' ? 'antiDelete' :
                  command === 'anticall' ? 'antiCall' : 'autoReply';
      settings[key] = val === 'on';
      reply(`✅ ${command} turned *${val}*.`);
      break;
    }

    case 'mode': {
      if (!isOwner) return reply('🔒 Owner-only.');
      const m = args[0]?.toLowerCase();
      if (!['public','private'].includes(m)) return reply('Usage: .mode public|private');
      settings.mode = m;
      reply(`✅ Mode set to *${m}*.`);
      break;
    }

    case 'settings': {
      const s = settings;
      reply(`⚙️ *Current Settings*\n\nantiDelete: ${s.antiDelete}\nantiLink: ${s.antiLink}\nantiCall: ${s.antiCall}\nautoStatus: ${s.autoStatus}\nautoReact: ${s.autoReact}\nautoReply: ${s.autoReply}\nmode: ${s.mode}`);
      break;
    }

    // ═══ NEW / UNIQUE FEATURES ═══
    case 'ghost': {
      // Ghost-mode: temporary chat that auto-deletes after 30 s
      if (!body) return reply('❌ Provide a message. It will be deleted after 30 s.');
      const sent = await reply(`👻 *Ghost message:* ${body}\n\n_(auto-deletes in 30 s)_`);
      setTimeout(() => {
        sockInstance.sendMessage(from, { delete: sent.key }).catch(() => {});
      }, 30000);
      break;
    }

    case 'encrypt': {
      // Simple Caesar-cipher text encryption
      if (!body) return reply('❌ Provide text to encrypt.');
      const shift = 3;
      const enc = body.replace(/[a-zA-Z]/g, c =>
        String.fromCharCode((c <= 'Z' ? 90 : 122) >= (c = c.charCodeAt(0) + shift) ? c : c - 26));
      reply(`🔐 *Encrypted:* \`${enc}\`\nDecrypt with .decrypt <text>`);
      break;
    }

    case 'decrypt': {
      if (!body) return reply('❌ Provide text to decrypt.');
      const shift = 3;
      const dec = body.replace(/[a-zA-Z]/g, c =>
        String.fromCharCode((c >= 'a' ? 97 : 65) <= (c = c.charCodeAt(0) - shift) ? c : c + 26));
      reply(`🔓 *Decrypted:* ${dec}`);
      break;
    }

    case 'poll': {
      if (!body) return reply('❌ Usage: .poll Question | Option1 | Option2');
      const parts = body.split('|').map(p => p.trim());
      if (parts.length < 3) return reply('❌ Need at least a question and two options.');
      const [question, ...options] = parts;
      await sockInstance.sendMessage(from, {
        poll: { name: question, values: options, selectableCount: 1 }
      });
      break;
    }

    case 'translate': {
      if (!body) return reply('❌ Usage: .translate <text>');
      try {
        const { data } = await axios.get(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(body)}&langpair=en|es`);
        reply(`🌐 *Translation:* ${data.responseData.translatedText}`);
      } catch(e) { reply('❌ Translation failed.'); }
      break;
    }

    case 'qr': {
      if (!body) return reply('❌ Provide text to encode.');
      try {
        const url = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(body)}`;
        await sockInstance.sendMessage(from, { image: { url }, caption: `📱 QR for: ${body}` }, { quoted: msg });
      } catch(e) { reply('❌ QR generation failed.'); }
      break;
    }

    case 'short': {
      if (!body) return reply('❌ Provide a URL to shorten.');
      try {
        const { data } = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(body)}`);
        reply(`🔗 Shortened: ${data}`);
      } catch(e) { reply('❌ Shortening failed.'); }
      break;
    }

    case 'sysinfo': {
      const mem = process.memoryUsage();
      const txt = `🖥️ *System Info*\n\nPlatform: ${process.platform}\nNode: ${process.version}\nRSS: ${(mem.rss / 1048576).toFixed(1)} MB\nHeap: ${(mem.heapUsed / 1048576).toFixed(1)} MB\nUptime: ${formatUptime(Date.now() - startTime)}`;
      reply(txt);
      break;
    }

    case 'couple': {
      // Pair two random members (fun)
      if (!isGroup) return reply('❌ Group-only command.');
      const meta = await sockInstance.groupMetadata(from);
      const members = meta.participants.map(p => p.id);
      if (members.length < 2) return reply('❌ Need at least 2 members.');
      const a = members[Math.floor(Math.random() * members.length)];
      let b = members[Math.floor(Math.random() * members.length)];
      while (b === a) b = members[Math.floor(Math.random() * members.length)];
      reply(`💞 *Today's couple:*\n\n@${a.split('@')[0]} ❤️ @${b.split('@')[0]}`, { mentions: [a, b] });
      break;
    }

    default:
      // Unknown command — silently ignore
      break;
  }
}

// ─────────────────────────────────────────────
//  yt-dlp HELPERS
// ─────────────────────────────────────────────
function ytDlpDownload(url, audioOnly) {
  return new Promise((resolve) => {
    const tmpDir = path.join(__dirname, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const id = Date.now();
    const outTemplate = path.join(tmpDir, `${id}.%(ext)s`);

    let ytArgs;
    if (audioOnly) {
      ytArgs = ['-x', '--audio-format', 'mp3', '-o', outTemplate, url];
    } else {
      ytArgs = ['-f', 'best[ext=mp4]/best', '-o', outTemplate, url];
    }

    const proc = spawn('yt-dlp', ytArgs);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        return resolve({ error: 'yt-dlp failed. Is the URL valid? ' + stderr.slice(0, 200) });
      }
      const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(String(id)));
      if (!files.length) return resolve({ error: 'No output file produced.' });
      const filePath = path.join(tmpDir, files[0]);

      // Auto-clean after 5 min
      setTimeout(() => { try { fs.unlinkSync(filePath); } catch(e){} }, 300000);

      resolve({ file: filePath, title: files[0] });
    });
  });
}

async function ytSearch(query) {
  return new Promise((resolve) => {
    const proc = spawn('yt-dlp', [`ytsearch5:${query}`, '--dump-json', '--flat-playlist']);
    let data = '';
    proc.stdout.on('data', d => { data += d.toString(); });
    proc.on('close', () => {
      const results = data.trim().split('\n').filter(Boolean).map(line => {
        try {
          const j = JSON.parse(line);
          return { title: j.title, url: j.url || `https://youtu.be/${j.id}`, duration: j.duration ? formatSeconds(j.duration) : null };
        } catch(e) { return null; }
      }).filter(Boolean);
      resolve(results);
    });
  });
}

function formatSeconds(s) {
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ─────────────────────────────────────────────
//  CHANNEL AUTO-JOIN & AUTO-REACT
// ─────────────────────────────────────────────
async function joinAndReactChannel(sockInstance) {
  try {
    await sockInstance.newsletterFollow(settings.channelJid);
    console.log('✅ Followed channel:', settings.channelJid);
  } catch(e) { console.log('Channel follow skipped:', e.message); }

  // Listen for channel messages and react
  sockInstance.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.remoteJid === settings.channelJid) {
        try {
          const emoji = settings.reactEmojis[Math.floor(Math.random() * settings.reactEmojis.length)];
          await sockInstance.newsletterReactMessage(settings.channelJid, msg.key.id, emoji);
        } catch(e) {}
      }
    }
  });
}

// ─────────────────────────────────────────────
//  UTILS
// ─────────────────────────────────────────────
function formatUptime(ms) {
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${d}d ${h}h ${m}m ${s}s`;
}

// ─────────────────────────────────────────────
//  BOT STARTUP
// ─────────────────────────────────────────────
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: true,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    cachedGroupMetadata: async (jid) => groupCache.get(jid),
    generateHighQualityLinkPreview: true
  });

  sock.ev.on('creds.update', saveCreds);
  attachSocketHandlers(sock, state, saveCreds);

  // If already registered, connection.update will fire 'open'
  // If not, QR will print to terminal and dashboard will show it
}

// ─────────────────────────────────────────────
//  EXPRESS SERVER START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Dashboard running on http://0.0.0.0:${PORT}`);
  console.log(`👑 ${settings.botName} ${settings.botVersion}`);
  console.log(`👨‍💻 Developer: ${settings.developer}`);
  startBot();
});

// ── Graceful shutdown ──
process.on('SIGINT', () => { console.log('Shutting down…'); process.exit(0); });
process.on('SIGTERM', () => { console.log('Shutting down…'); process.exit(0); });
