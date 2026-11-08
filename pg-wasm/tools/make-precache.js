#!/usr/bin/env node
// Writes DIST/precache-manifest.json: the list of all files in the build (for
// the service worker) and a hash of their contents (the cache version).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dist = path.resolve(process.argv[2]);
const files = [];
const hash = crypto.createHash('sha256');
const walk = (dir) => {
	for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const full = path.join(dir, ent.name);
		if (ent.isDirectory()) walk(full);
		else {
			const rel = path.relative(dist, full).split(path.sep).join('/');
			if (rel === 'precache-manifest.json') continue;
			// The problem library is cached as problems are used (see sw.js), not up front.
			if (rel.startsWith('opl/') && rel !== 'opl/index.json') continue;
			files.push(rel);
			hash.update(rel).update(fs.readFileSync(full));
		}
	}
};
walk(dist);
files.unshift('./');
fs.writeFileSync(path.join(dist, 'precache-manifest.json'),
	JSON.stringify({ version: hash.digest('hex').slice(0, 16), files }, null, '\t') + '\n');
console.error(`precache-manifest.json: ${files.length} files`);
