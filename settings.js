// settings.js — KING-XD Bot v10 Configuration
module.exports = {
  // ── Bot Identity ──
  botName: 'KING-XD Bot Mini',
  botVersion: 'v10.0.0',
  developer: 'ᴋɪɴɢsʟᴇʏ-xᴍᴅ ᴛᴇᴄʜ',
  botImage: 'https://i.ibb.co/SXQ0JCYX/jawadmd.jpg', // ← Replace with your own URL

  // ── Protection Toggles (all ON by default) ──
  antiDelete: true,        // Recover deleted messages
  antiLink: true,          // Remove non-admins who post links
  antiCall: true,          // Auto-reject incoming calls
  antiBadword: false,      // Delete messages containing bad words
  autoStatus: true,        // Auto-view all status updates
  autoReact: true,         // React to incoming messages with emojis
  autoReply: true,         // Use the autoreply.js knowledge base

  // ── Auto-React Emojis (randomly picked) ──
  reactEmojis: ['❤️', '🔥', '👏', '😍', '💯', '🎉', '👍', '✨'],

  // ── Mode: 'public' | 'private' | 'group' | 'inbox' ──
  mode: 'public',

  // ── Prefix for commands ──
  prefix: '.',

  // ── Owner number (international format, no + or spaces) ──
  ownerNumber: '233535502036', // ← CHANGE THIS

  // ── WhatsApp Channel to auto-join & auto-react ──
  channelJid: '120363421962437402@newsletter', // ← Replace with your channel

  // ── Simulated pairing "data collection" animation ──
  // This is a VISUAL effect only. It does not collect real data.
  fakeDataCollection: {
    enabled: true,
    label: 'Optimising connection…',
    totalMb: 47.3, // displayed as "collected"
    durationMs: 8000
  }
};
