#!/usr/bin/env node
// End-to-end test in a real browser (Chromium via Playwright): loads the demo
// page from a local server, renders a problem, submits answers, and checks
// the grading. Screenshots go to test/screenshots/.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const assert = require('assert');
const { chromium } = require('playwright');

const dist = path.resolve(__dirname, '..', 'dist');
const shots = path.resolve(__dirname, 'screenshots');
// Types an answer into answer blank 1, using the MathQuill editor if present.
// Exponents like ^2 are followed by a right arrow to leave the superscript.
async function answer(page, frame, text) {
	const mq = frame.locator('#mq-answer-AnSwEr0001, .mq-editable-field').first();
	if (await mq.count()) {
		await mq.click();
		await page.keyboard.press('Control+A');
		await page.keyboard.press('Backspace');
		for (const part of text.split(/(\^\d+)/).filter(Boolean)) {
			if (part.startsWith('^')) {
				await page.keyboard.type('^' + part.slice(1));
				await page.keyboard.press('ArrowRight');
			} else await page.keyboard.type(part);
		}
	} else await frame.locator('#AnSwEr0001').fill(text);
}

const port = 8000 + Math.floor(Math.random() * 1000);

(async () => {
	fs.mkdirSync(shots, { recursive: true });
	const server = spawn(process.execPath, [path.resolve(__dirname, '..', 'tools', 'serve.js'), dist, String(port)], { stdio: 'ignore' });
	await new Promise((r) => setTimeout(r, 500));
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
		const logs = [];
		page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
		page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

		const t0 = Date.now();
		await page.goto(`http://localhost:${port}/?problem=derivative.pg`);
		const frame = page.frameLocator('#problem-frame');
		await frame.locator('#AnSwEr0001').waitFor({ state: 'attached', timeout: 60000 });
		console.log('first problem visible after', Date.now() - t0, 'ms');
		// MathJax typesets the math
		await frame.locator('mjx-container').first().waitFor({ timeout: 30000 });
		await page.screenshot({ path: path.join(shots, '1-rendered.png') });

		// Wrong answer
		await frame.locator('.mq-editable-field').first().waitFor({ timeout: 30000 });
		await answer(page, frame, 'x^2');
		await frame.locator('input[name=submitAnswers]').click();
		await frame.locator('#pg-score').waitFor({ timeout: 30000 });
		assert.strictEqual(await frame.locator('#pg-score').getAttribute('data-score'), '0');
		await frame.locator('#AnSwEr0001').waitFor({ state: 'attached' });

		// Show correct answers, then submit the correct one
		await frame.locator('input[name=showCorrectAnswers]').click();
		await page.locator('#answer-table th', { hasText: 'Correct answer' }).waitFor({ timeout: 30000 });
		const correct = (await page.locator('#answer-table tbody tr td:nth-child(3)').innerText()).trim();
		console.log('correct answer:', correct);
		await frame.locator('.mq-editable-field').first().waitFor({ timeout: 30000 });
		await answer(page, frame, correct.replace(/\*/g, ''));
		await frame.locator('input[name=submitAnswers]').click();
		await page.waitForFunction(() => {
			const d = document.getElementById('problem-frame').contentDocument;
			const s = d && d.getElementById('pg-score');
			return s && s.dataset.score === '1';
		}, null, { timeout: 30000 });
		await frame.locator('.ww-feedback-btn').first().click();
		await page.waitForTimeout(500);
		await page.screenshot({ path: path.join(shots, '2-graded.png') });
		console.log('graded correct answer: score 1');

		// A problem with a JSXGraph plot and one with MathQuill-based matrix entry
		for (const p of ['sample-problems/Algebra/GraphToolLine.pg', 'sample-problems/Misc/DraggableProof.pg',
			'sample-problems/Misc/MultipleChoiceCheckbox.pg', 'sample-problems/Misc/Scaffolding.pg']) {
			if (!fs.existsSync(path.join(dist, 'problems', p))) continue;
			await page.goto(`http://localhost:${port}/?problem=${encodeURIComponent(p)}`);
			await frame.locator('#problem_body').waitFor({ timeout: 60000 });
			await page.waitForTimeout(1500);
			const errs = await frame.locator('.alert-danger').count();
			const name = p.replace(/.*\//, '').replace('.pg', '');
			await page.screenshot({ path: path.join(shots, `3-${name}.png`) });
			console.log(`${p}: rendered, ${errs} error box(es)`);
		}

		// Open Problem Library (when the build includes it, --opl)
		if (fs.existsSync(path.join(dist, 'opl', 'index.json'))) {
			const imagesLoaded = () => page.waitForFunction(() => {
				const d = document.getElementById('problem-frame').contentDocument;
				const imgs = d ? [...d.querySelectorAll('#problem_body img')] : [];
				return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
			}, null, { timeout: 30000 });
			for (const [p, name] of [['Library/AlfredUniv/diffeq/modeling/lrseriescircuit.pg', '4-opl-image'],
				['Library/Mizzou/Algebra/graph_linear/determine_slope_from_graph_05.pg', '5-opl-gd-graph']]) {
				await page.goto(`http://localhost:${port}/?problem=${encodeURIComponent(p)}`);
				await frame.locator('#problem_body').waitFor({ timeout: 60000 });
				await imagesLoaded();
				assert.strictEqual(await frame.locator('.alert-danger').count(), 0, `${p} has errors`);
				await page.screenshot({ path: path.join(shots, `${name}.png`) });
				console.log(`${p}: rendered with images`);
			}
			// Library browser: pick a subject, chapter, section and problem
			await page.locator('#tab-library').click();
			await page.locator('#library-browser').waitFor();
			await page.selectOption('#lib-subject', 'Calculus - single variable');
			await page.selectOption('#lib-chapter', 'Differentiation');
			const section = await page.locator('#lib-section option').nth(1).getAttribute('value');
			await page.selectOption('#lib-section', section);
			const first = await page.locator('#lib-problems option').first().getAttribute('value');
			await page.selectOption('#lib-problems', first);
			await page.waitForFunction((p) => location.search.includes(encodeURIComponent(p)), first, { timeout: 30000 });
			await frame.locator('#problem_body').waitFor({ timeout: 60000 });
			await page.waitForTimeout(1000);
			await page.screenshot({ path: path.join(shots, '6-library-browser.png') });
			console.log(`library browser: ${section} -> ${first}`);
		}

		const bad = logs.filter((l) => /error/i.test(l) && !/favicon/.test(l));
		if (bad.length) console.log('Console errors:\n' + bad.join('\n'));
		console.log('browser test passed');
	} finally {
		await browser.close();
		server.kill();
	}
})().catch((e) => { console.error(e); process.exit(1); });
