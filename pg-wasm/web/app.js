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

// URL of a file under the templates directory, using the mounts from pg-wasm-config.json.
function templateURL(path) {
	const mounts = Object.entries(pg.config?.mounts ?? {}).sort((a, b) => b[0].length - a[0].length);
	for (const [dir, url] of mounts) if (path.startsWith(dir)) return url + path.slice(dir.length);
	return null;
}

// Loads a problem by its path in the templates directory, e.g.
// "problems/derivative.pg" or "Library/Rochester/setDerivatives1/c1s5p8.pg".
async function loadProblem(path) {
	await pg.ready;
	const url = templateURL(path);
	if (!url) throw new Error(`Unknown location: ${path}`);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
	sourceEl.value = await res.text();
	current.path = path;
	history.replaceState(null, '', '?problem=' + encodeURIComponent(path));
	await render();
}

const showError = (err) => {
	setStatus('Error', 'danger');
	frame.srcdoc = `<pre style="color:#b00;white-space:pre-wrap">${escapeHTML(err.message || err)}</pre>`;
};

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
	select.addEventListener('change', () => loadProblem('problems/' + select.value).catch(showError));
	const wanted = (new URLSearchParams(location.search).get('problem') ?? '').replace(/^problems\//, '');
	if (index.some((p) => p.path === wanted)) select.value = wanted;
	return 'problems/' + select.value;
}

// ##### Problem library browser #####

let library = null;
const fillSelect = (select, items, placeholder) => {
	select.replaceChildren(new Option(placeholder, ''), ...items.map(([value, label]) => new Option(label, value)));
};

async function initLibrary() {
	const note = $('lib-note');
	const mounts = pg.config?.mounts ?? {};
	const where = (mounts['Library/'] ?? '').startsWith('http') ? 'GitHub (needs an internet connection)' : 'this site';
	note.textContent = `Problems from the Open Problem Library ("Library/...") and Contrib ("Contrib/...") are loaded from ${where}.`;
	if (!pg.config?.libraryIndex) return;
	library = await (await fetch(pg.config.libraryIndex)).json();
	$('library-browser').hidden = false;
	const subject = $('lib-subject'), chapter = $('lib-chapter'), section = $('lib-section'), list = $('lib-problems');
	fillSelect(subject, Object.keys(library.tree).map((k) => [k, k]), `Subject (${library.problems.length} problems)`);
	fillSelect(chapter, [], 'Chapter');
	fillSelect(section, [], 'Section');
	subject.addEventListener('change', () => {
		const chapters = library.tree[subject.value] ?? {};
		fillSelect(chapter, Object.keys(chapters).map((k) => [k, k]), 'Chapter');
		fillSelect(section, [], 'Section');
		list.replaceChildren();
	});
	chapter.addEventListener('change', () => {
		const sections = library.tree[subject.value]?.[chapter.value] ?? {};
		fillSelect(section, Object.entries(sections).map(([k, v]) => [k, `${k} (${v.length})`]), 'Section');
		list.replaceChildren();
	});
	section.addEventListener('change', () => {
		const ids = library.tree[subject.value]?.[chapter.value]?.[section.value] ?? [];
		list.replaceChildren(...ids.map((i) => {
			const [path, title] = library.problems[i];
			return new Option(title ? `${title} — ${path}` : path, path);
		}));
	});
	list.addEventListener('change', () => {
		$('lib-path').value = list.value;
		loadProblem(list.value).catch(showError);
	});
}

$('lib-path-form').addEventListener('submit', (e) => {
	e.preventDefault();
	const path = $('lib-path').value.trim().replace(/^\/+/, '');
	if (path) loadProblem(path).catch(showError);
});

for (const tab of document.querySelectorAll('[data-panel]')) {
	tab.addEventListener('click', () => {
		for (const t of document.querySelectorAll('[data-panel]')) {
			t.classList.toggle('active', t === tab);
			t.setAttribute('aria-selected', t === tab);
			$(t.dataset.panel).hidden = t !== tab;
		}
	});
}
const showTab = (id) => document.getElementById(id).click();

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
// Opening files: the .pg file is shown in the editor, and all the selected
// files (e.g. its images) are written to a directory in the virtual file system
// so the problem can use them.
let uploadCount = 0;
$('file-input').addEventListener('change', async (e) => {
	const files = [...e.target.files];
	const pgFile = files.find((f) => /\.pg$/i.test(f.name)) ?? files[0];
	if (!pgFile) return;
	const dir = `local/upload${++uploadCount}/`;
	const contents = {};
	for (const f of files) contents[f.name] = await f.arrayBuffer();
	await pg.writeFiles(dir, contents);
	sourceEl.value = await pgFile.text();
	current.path = dir + pgFile.name;
	e.target.value = '';
	render();
});

(async () => {
	try {
		const first = await loadIndex();
		await pg.ready;
		initLibrary().catch((e) => console.warn('Library index:', e));
		const wanted = new URLSearchParams(location.search).get('problem');
		if (wanted && !wanted.startsWith('problems/')) {
			showTab('tab-library');
			$('lib-path').value = wanted;
			await loadProblem(wanted);
		} else await loadProblem(first);
	} catch (err) {
		showError(err);
	}
})();

// Cache everything for offline use (needs http(s); not available for file:// URLs).
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
	navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker not registered:', e));
}
