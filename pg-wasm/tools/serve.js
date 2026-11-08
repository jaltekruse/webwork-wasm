#!/usr/bin/env node
// Minimal static file server for trying out the build locally:
//   node tools/serve.js dist [port]
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.argv[2] || 'dist');
const port = Number(process.argv[3] || process.env.PORT || 8080);
const types = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript',
	'.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm',
	'.data': 'application/octet-stream', '.pg': 'text/plain; charset=utf-8', '.png': 'image/png',
	'.svg': 'image/svg+xml', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.woff': 'font/woff',
	'.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};
http.createServer((req, res) => {
	let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
	if (p.endsWith('/')) p += 'index.html';
	const file = path.join(root, path.normalize(p));
	if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
	fs.readFile(file, (err, data) => {
		if (err) { res.writeHead(404); return res.end('Not found'); }
		res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
		res.end(data);
	});
}).listen(port, () => console.log(`Serving ${root} at http://localhost:${port}/`));
