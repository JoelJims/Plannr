const http = require('http');
const fs = require('fs');
const path = require('path');
const root = __dirname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.db': 'application/octet-stream' };
const port = Number(process.argv[2] || 8836);
http.createServer((req, res) => {
  const filePath = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log('listening ' + port));
