/* Demo front end for rendering PG problems in the browser. */
'use strict';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const sourceEl = $('source');
const seedEl = $('seed');
const frame = $('problem-frame');
const renderBtn = $('render');

const setStatus = (text, kind = 'secondary') => {
	statusEl.textContent = text;
	statusEl.className = `badge text-bg-${kind}`;
};

const pg = new PGClient({
	baseURL: './',
	onStatus: (text) => setStatus(text, text === 'Ready' ? 'success' : 'secondary')
});

let current = { path: '', inputs: null, action: null };
let busy = false;

const escapeHTML = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function render(inputs = null, action = null) {
	if (busy) return;
	busy = true;
	renderBtn.disabled = true;
	setStatus(inputs ? 'Grading...' : 'Rendering...', 'info');
	current.inputs = inputs;
	current.action = action;
	const request = {
		source: sourceEl.value,
		problemSeed: Number(seedEl.value) || 1234,
		sourceFilePath: current.path,
		showHints: $('show-hints').checked ? 1 : 0,
		showSolutions: $('show-solutions').checked ? 1 : 0,
		inputs: inputs ?? {},
		processAnswers: inputs ? 1 : 0,
		...(inputs ? PGClient.actionOptions(action) : {})
	};
	try {
		const result = await pg.render(request);
		frame.srcdoc = pg.problemPage(result, { problemId: 'main' });
		showResults(result, action);
		$('timing').textContent = `Rendered in ${result.renderTime} ms` +
			(pg.timing ? ` · Perl + PG loaded in ${pg.timing.runtime + pg.timing.pgLoad} ms` : '');
		setStatus('Ready', 'success');
	} catch (err) {
		frame.srcdoc = `<pre style="color:#b00;white-space:pre-wrap">${escapeHTML(err.message)}</pre>`;
		$('results').innerHTML = '';
		setStatus('Error', 'danger');
	} finally {
		busy = false;
		renderBtn.disabled = false;
	}
}

function showResults(result, action) {
	const out = $('results');
	if (!result.submitted || action === 'previewAnswers') {
		out.innerHTML = '';
		return;
	}
	const order = result.flags?.ANSWER_ENTRY_ORDER ?? Object.keys(result.answers).sort();
	const showCorrect = action === 'showCorrectAnswers';
	const rows = order
		.filter((label) => result.answers[label])
		.map((label, i) => {
			const a = result.answers[label];
			const pct = Math.round((a.score ?? 0) * 100);
			return `<tr>
				<td>${i + 1}</td>
				<td><code>${escapeHTML(a.original_student_ans)}</code></td>
				${showCorrect ? `<td><code>${escapeHTML(a.correct_ans)}</code></td>` : ''}
				<td><span class="badge text-bg-${pct === 100 ? 'success' : pct > 0 ? 'warning' : 'danger'}">${pct}%</span></td>
				<td>${escapeHTML(a.ans_message)}</td>
			</tr>`;
		});
	out.innerHTML = `<table class="table table-sm table-bordered" id="answer-table">
		<thead><tr><th>#</th><th>Your answer</th>${showCorrect ? '<th>Correct answer</th>' : ''}<th>Score</th><th>Message</th></tr></thead>
		<tbody>${rows.join('')}</tbody></table>`;
}

window.addEventListener('message', (event) => {
	if (event.source !== frame.contentWindow) return;
	const msg = event.data || {};
	if (msg.type === 'pg-submit') render(msg.inputs, msg.action);
	else if (msg.type === 'pg-resize') frame.style.height = Math.max(msg.height + 4, 150) + 'px';
});

async function loadProblem(path) {
	const res = await fetch('problems/' + path);
	if (!res.ok) throw new Error(`Could not load ${path}`);
	sourceEl.value = await res.text();
	current.path = path;
	await render();
}

async function loadIndex() {
	const select = $('problem-select');
	const index = await (await fetch('problems/index.json')).json();
	const groups = new Map();
	for (const p of index) {
		const dir = p.path.includes('/') ? p.path.replace(/\/[^/]*$/, '').replace(/^sample-problems\//, 'PG samples: ') : 'Examples';
		if (!groups.has(dir)) groups.set(dir, []);
		groups.get(dir).push(p);
	}
	for (const [dir, problems] of groups) {
		const og = document.createElement('optgroup');
		og.label = dir;
		for (const p of problems) {
			const opt = document.createElement('option');
			opt.value = p.path;
			opt.textContent = p.title;
			og.append(opt);
		}
		select.append(og);
	}
	select.addEventListener('change', () => loadProblem(select.value));
	const wanted = new URLSearchParams(location.search).get('problem');
	select.value = index.some((p) => p.path === wanted) ? wanted : index[0].path;
	return select.value;
}

renderBtn.addEventListener('click', () => render());
$('new-seed').addEventListener('click', () => {
	seedEl.value = Math.floor(Math.random() * 99999) + 1;
	render();
});
seedEl.addEventListener('change', () => render());
$('show-hints').addEventListener('change', () => render(current.inputs, current.action));
$('show-solutions').addEventListener('change', () => render(current.inputs, current.action));
sourceEl.addEventListener('keydown', (e) => {
	if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); render(); }
	if (e.key === 'Tab' && !e.shiftKey) {
		e.preventDefault();
		sourceEl.setRangeText('\t', sourceEl.selectionStart, sourceEl.selectionEnd, 'end');
	}
});
$('file-input').addEventListener('change', async (e) => {
	const file = e.target.files[0];
	if (!file) return;
	sourceEl.value = await file.text();
	current.path = file.name;
	render();
});

(async () => {
	try {
		const first = await loadIndex();
		await pg.ready;
		await loadProblem(first);
	} catch (err) {
		setStatus('Error', 'danger');
		frame.srcdoc = `<pre style="color:#b00;white-space:pre-wrap">${escapeHTML(err.stack || err)}</pre>`;
	}
})();

// Cache everything for offline use (needs http(s); not available for file:// URLs).
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
	navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker not registered:', e));
}
