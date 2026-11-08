#!/usr/bin/env node
// Renders and grades problems with the WebAssembly build, in node.
//   node test/node-render.test.js            # quick checks
//   node test/node-render.test.js --all      # also render every sample problem
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const dist = path.resolve(__dirname, '..', 'dist') + '/';
globalThis.require = require; // used by Emscripten's generated code in node
globalThis.__dirname = dist;
const PGEngine = require(dist + 'pg-engine.js');

const loadScript = (file) => vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });

(async () => {
	const engine = new PGEngine({ baseURL: dist, loadScript });
	const timing = await engine.init();
	console.log('init:', timing, engine.bootMessages.length ? engine.bootMessages : '');

	const source = fs.readFileSync(dist + 'problems/derivative.pg', 'utf8');

	// 1. Render without answers
	let r = engine.render({ source, problemSeed: 1234 });
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
		let total = 0;
		const t0 = Date.now();
		for (const p of index) {
			total++;
			const src = fs.readFileSync(dist + 'problems/' + p.path, 'utf8');
			const res = engine.render({
				source: src, problemSeed: 1234, sourceFilePath: p.path,
				templateDirectory: '/nonexistent/', inputs: { submitAnswers: 1 }
			});
			const problems = [];
			if (res.errors) problems.push('errors: ' + res.errors.split('\n').slice(0, 3).join(' | '));
			if (res.warnings) problems.push('warnings: ' + res.warnings.split('\n').slice(0, 3).join(' | '));
			if (problems.length) failures.push({ path: p.path, problems });
		}
		console.log(`rendered ${total} problems in ${Date.now() - t0} ms; ${failures.length} with errors/warnings`);
		for (const f of failures) console.log(' -', f.path, '\n     ', f.problems.join('\n      '));
		if (process.argv.includes('--strict') && failures.length) process.exit(1);
	}
})().catch((e) => { console.error(e); process.exit(1); });
