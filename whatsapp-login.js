// Standalone WhatsApp login/session proof — run with: node whatsapp-login.js
// Renders the QR in the terminal, persists the session via LocalAuth, and
// reconnects without a new scan on subsequent runs. No sending logic here.
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const SESSION_DIR = './.wwebjs_auth'; // LocalAuth writes the session here

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: { headless: true },
});

let sawQr = false;

client.on('qr', (qr) => {
  sawQr = true;
  qrcode.generate(qr, { small: true });
  console.log('\nScan this with WhatsApp: Settings → Linked Devices → Link a Device');
});

client.on('authenticated', () => {
  console.log('Authenticated — saving session…');
});

client.on('auth_failure', (msg) => {
  console.error('AUTH FAILED:', msg);
  process.exitCode = 1;
});

client.on('ready', () => {
  const how = sawQr ? 'after scan' : 'from saved session (no QR needed)';
  console.log(`\n✅ WhatsApp linked successfully! Session saved. (${how})`);
  console.log(`   Session folder: ${SESSION_DIR}`);
  console.log('   Reconnected automatically — press Ctrl+C to exit.');
});

client.on('disconnected', (reason) => {
  console.error('Disconnected:', reason);
});

console.log('Starting WhatsApp client… (a QR will appear if no saved session)');
client.initialize();
