#!/usr/bin/env node
// Builds a browsable index of a problem library from the tags in its .pg files.
//
//   node tools/opl-index.js OUTPUT.json Library=/path/to/OpenProblemLibrary [Contrib=/path/to/Contrib ...]
//
// Output: { tree: { subject: { chapter: { section: [problem index, ...] } } },
//           problems: [ [path, title], ... ] }
// Paths are relative to the templates directory (e.g. "Library/Rochester/...").
// Problems without a DBsubject tag are listed under "(Untagged)" by directory.
const fs = require('fs');
const path = require('path');

const [, , output, ...roots] = process.argv;
if (!output || !roots.length) {
	console.error('Usage: opl-index.js OUTPUT.json Name=/dir [Name=/dir ...]');
	process.exit(1);
}

const tag = (src, name) => {
	const m = src.match(new RegExp(`^\\s*#+\\s*${name}\\s*\\(\\s*['"]?([^'")\\n]*?)['"]?\\s*\\)`, 'im'));
	return m && m[1].trim() ? m[1].trim().replace(/\s+/g, ' ') : null;
};

const tree = {};
const problems = [];
// Tags are not consistent in capitalization ("Middle School"/"Middle school"),
// so use the first spelling seen for each name.
const canonical = new Map();
const canon = (s) => {
	const key = s.toLowerCase();
	if (!canonical.has(key)) canonical.set(key, s);
	return canonical.get(key);
};
const add = (subject, chapter, section, idx) => {
	[subject, chapter, section] = [canon(subject), canon(chapter), canon(section)];
	((tree[subject] ??= {})[chapter] ??= {})[section] ??= [];
	tree[subject][chapter][section].push(idx);
};

for (const spec of roots) {
	const [name, dir] = spec.split('=');
	const walk = (d) => {
		let entries;
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(d, ent.name);
			if (ent.isDirectory()) {
				if (ent.name !== '.git' && ent.name !== 'macros') walk(full);
			} else if (ent.name.endsWith('.pg')) {
				// Only the header matters, and some files are large.
				const fd = fs.openSync(full, 'r');
				const buf = Buffer.alloc(8192);
				const n = fs.readSync(fd, buf, 0, buf.length, 0);
				fs.closeSync(fd);
				const src = buf.toString('utf8', 0, n);
				const rel = `${name}/${path.relative(dir, full).split(path.sep).join('/')}`;
				const title = tag(src, 'TitleText1') ? `${tag(src, 'TitleText1')} ${tag(src, 'Section1') ?? ''}`.trim() : null;
				const idx = problems.push(title ? [rel, title] : [rel]) - 1;
				const subject = tag(src, 'DBsubject');
				if (subject) add(subject, tag(src, 'DBchapter') ?? '(No chapter)', tag(src, 'DBsection') ?? '(No section)', idx);
				else add(`(Untagged) ${name}`, rel.split('/')[1] ?? name, rel.split('/').slice(2, -1).join('/') || '.', idx);
			}
		}
	};
	walk(dir);
}

const sorted = (obj, depth) => Object.fromEntries(Object.keys(obj).sort((a, b) => a.localeCompare(b))
	.map((k) => [k, depth ? sorted(obj[k], depth - 1) : obj[k]]));
fs.writeFileSync(output, JSON.stringify({ tree: sorted(tree, 2), problems }));
console.error(`${path.basename(output)}: ${problems.length} problems, ${Object.keys(tree).length} subjects`);
