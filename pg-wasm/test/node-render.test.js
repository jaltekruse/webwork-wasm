#!/usr/bin/env node
// Renders and grades problems with the WebAssembly build, in node.
//   node test/node-render.test.js            # quick checks
//   node test/node-render.test.js --all      # also render every sample problem
//   OPL_DIR=/path/to/webwork-open-problem-library \
//     node test/node-render.test.js --opl=500  # also render 500 random OPL problems
//   (--opl=all renders all of them; --seed=N picks a different random sample)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const dist = path.resolve(__dirname, '..', 'dist') + '/';
globalThis.require = require; // used by Emscripten's generated code in node
globalThis.__dirname = dist;
const PGEngine = require(dist + 'pg-engine.js');

const loadScript = (file) => vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
const fetchSync = (file) => {
	try {
		return fs.readFileSync(file);
	} catch {
		return null;
	}
};
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? '').split('=')[1];
const oplDir = process.env.OPL_DIR;
const mounts = { 'problems/': dist + 'problems/' };
if (oplDir) Object.assign(mounts, { 'Library/': oplDir + '/OpenProblemLibrary/', 'Contrib/': oplDir + '/Contrib/' });

// Summarizes the problems with a render: errors and warnings, grouped by message.
function report(label, failures, total, ms) {
	console.log(`${label}: rendered ${total} problems in ${ms} ms; ${failures.length} with errors/warnings`);
	const groups = new Map();
	for (const f of failures) {
		const key = f.problems[0].replace(/\/opt\/templates\/[^ ]*|line \d+|\d+(\.\d+)?/g, '#').slice(0, 140);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(f.path);
	}
	for (const [key, paths] of [...groups].sort((a, b) => b[1].length - a[1].length))
		console.log(`  ${String(paths.length).padStart(4)} × ${key}\n         e.g. ${paths.slice(0, 2).join(', ')}`);
}

function check(engine, request, pathLabel) {
	const res = engine.render(request);
	const problems = [];
	if (res.errors) problems.push('errors: ' + res.errors.split('\n').filter((l) => /\S/.test(l) && !/^ERRORS from evaluating/.test(l)).slice(0, 2).join(' | '));
	if (res.warnings) problems.push('warnings: ' + res.warnings.split('\n').filter((l) => /\S/.test(l)).slice(0, 2).join(' | '));
	return problems.length ? { path: pathLabel, problems } : null;
}

(async () => {
	const engine = new PGEngine({ baseURL: dist, loadScript, fetchSync, mounts });
	const timing = await engine.init();
	console.log('init:', timing, engine.bootMessages.length ? engine.bootMessages : '');

	const source = fs.readFileSync(dist + 'problems/derivative.pg', 'utf8');

	// 0. Render by file path (loaded through the "problems/" mount)
	let byPath = engine.render({ sourceFilePath: 'problems/derivative.pg', problemSeed: 1234 });
	assert.strictEqual(byPath.errors, '', byPath.errors);
	assert.match(byPath.body_text, /name="AnSwEr0001"/);

	// 1. Render without answers
	let r = engine.render({ source, problemSeed: 1234 });
	void byPath;
	assert.strictEqual(r.errors, '', r.errors);
	assert.match(r.body_text, /name="AnSwEr0001"/);
	const m = r.body_text.match(/f\(x\) = \{?([^\\]+?)\}?\\\)/);
	console.log('rendered in', r.renderTime, 'ms; f(x) =', m && m[1]);

	// 2. Get the correct answer, then submit a correct and an incorrect answer
	r = engine.render({ source, problemSeed: 1234, inputs: { AnSwEr0001: '' } });
	const correct = r.answers.AnSwEr0001.correct_ans;
	r = engine.render({ source, problemSeed: 1234, inputs: { AnSwEr0001: correct } });
	assert.strictEqual(r.answers.AnSwEr0001.score, 1, 'correct answer should score 1');
	assert.strictEqual(r.score, 1);
	console.log('correct answer', correct, '-> score', r.score, 'in', r.renderTime, 'ms');
	r = engine.render({ source, problemSeed: 1234, inputs: { AnSwEr0001: 'x^2' } });
	assert.strictEqual(r.answers.AnSwEr0001.score, 0);
	console.log('wrong answer x^2 -> score', r.score, 'in', r.renderTime, 'ms');

	// 3. Same seed gives the same problem; different seeds give different ones
	const a = engine.render({ source, problemSeed: 1 }).body_text;
	const b = engine.render({ source, problemSeed: 1 }).body_text;
	const c = engine.render({ source, problemSeed: 2 }).body_text;
	assert.strictEqual(a, b);
	assert.notStrictEqual(a, c);

	// 4. Syntax errors are reported, and don't break later renders (memory snapshot)
	r = engine.render({ source: 'DOCUMENT(); $x = ; ENDDOCUMENT();' });
	assert.ok(r.errors.length > 0, 'expected a translator error');
	r = engine.render({ source, problemSeed: 1234 });
	assert.strictEqual(r.errors, '');
	console.log('quick checks passed');

	if (process.argv.includes('--all')) {
		const index = JSON.parse(fs.readFileSync(dist + 'problems/index.json', 'utf8'));
		const failures = [];
		const t0 = Date.now();
		for (const p of index) {
			const f = check(engine, { sourceFilePath: 'problems/' + p.path, problemSeed: 1234, inputs: { submitAnswers: 1 } }, p.path);
			if (f) failures.push(f);
		}
		report('sample problems', failures, index.length, Date.now() - t0);
		for (const f of failures) console.log(' -', f.path, '\n     ', f.problems.join('\n      '));
		if (process.argv.includes('--strict') && failures.length) process.exit(1);
	}

	const oplCount = arg('opl');
	if (oplCount) {
		if (!oplDir) throw new Error('Set OPL_DIR to a clone of webwork-open-problem-library');
		const all = [];
		const walk = (dir, rel) => {
			for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
				if (ent.isDirectory()) walk(path.join(dir, ent.name), rel + ent.name + '/');
				else if (ent.name.endsWith('.pg')) all.push(rel + ent.name);
			}
		};
		walk(path.join(oplDir, 'OpenProblemLibrary'), 'Library/');
		all.sort();
		// Deterministic pseudo-random sample
		let seed = Number(arg('seed') ?? 1);
		const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
		for (let i = all.length - 1; i > 0; i--) {
			const j = Math.floor(rand() * (i + 1));
			[all[i], all[j]] = [all[j], all[i]];
		}
		const sample = oplCount === 'all' ? all : all.slice(0, Number(oplCount));
		const failures = [];
		const t0 = Date.now();
		for (const p of sample) {
			const f = check(engine, { sourceFilePath: p, problemSeed: 1234, inputs: { submitAnswers: 1 } }, p);
			if (f) failures.push(f);
		}
		report(`OPL sample (of ${all.length})`, failures, sample.length, Date.now() - t0);
		if (process.argv.includes('--verbose')) for (const f of failures) console.log(' -', f.path, '\n     ', f.problems.join('\n      '));
	}
})().catch((e) => { console.error(e); process.exit(1); });
