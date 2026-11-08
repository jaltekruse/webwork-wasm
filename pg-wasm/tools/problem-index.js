#!/usr/bin/env node
// Writes a JSON index of the .pg files in a directory (recursively) to stdout,
// using the "## DESCRIPTION" / "## KEYWORDS" / title comments when present.
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const out = [];
const walk = (dir) => {
	for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const full = path.join(dir, ent.name);
		if (ent.isDirectory()) walk(full);
		else if (ent.name.endsWith('.pg')) {
			const src = fs.readFileSync(full, 'utf8');
			const title = (src.match(/^##\s*TITLE\s*[:(]?\s*['"]?([^'")\n]+)/m) || [])[1];
			const desc = (src.match(/^##\s*DESCRIPTION\s*\n##\s*(.+)/m) || [])[1];
			out.push({
				path: path.relative(root, full).split(path.sep).join('/'),
				title: (title || desc || ent.name.replace(/\.pg$/, '')).trim()
			});
		}
	}
};
walk(root);
process.stdout.write(JSON.stringify(out, null, '\t') + '\n');
