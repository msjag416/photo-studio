// Test web server that behaves like GitHub Pages: it compresses files (gzip) and reports
// the compressed size. Run: node tests/server.mjs <folder> [port]
import http from 'http'; import fs from 'fs'; import path from 'path'; import zlib from 'zlib';
const root = process.argv[2], port = Number(process.argv[3] || 8090);
const types = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream' };
http.createServer((req, res) => {
  let f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (f.endsWith('/')) f += 'index.html';
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const body = fs.readFileSync(f);
  const headers = { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
  if (/gzip/.test(req.headers['accept-encoding'] || '')) {
    const z = zlib.gzipSync(body);
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': z.length });
    return res.end(z);
  }
  res.writeHead(200, { ...headers, 'Content-Length': body.length });
  res.end(body);
}).listen(port);
