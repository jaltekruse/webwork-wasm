/* Client-side API for rendering PG problems with the WebAssembly PG engine.
 *
 *   const pg = new PGClient({ baseURL: 'https://example.org/pg-wasm/' });
 *   const result = await pg.render({ source, problemSeed: 1234 });
 *   iframe.srcdoc = pg.problemPage(result, { problemId: 'p1' });
 *
 *   // When the student submits the form in the iframe, the page receives
 *   // window 'message' events with data { type: 'pg-submit', problemId, inputs, action }.
 *   // Re-render with those inputs to grade them:
 *   const graded = await pg.render({ source, problemSeed: 1234, inputs, ...PGClient.actionOptions(action) });
 *
 * See index.html / app.js for a complete example.
 */
(function (global) {
	'use strict';

	const escapeHTML = (s) =>
		String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

	class PGClient {
		constructor(options = {}) {
			this.baseURL = new URL(options.baseURL ?? './', global.location.href).href;
			this.timeout = options.timeout ?? 30000;
			this.onStatus = options.onStatus ?? (() => {});
			this.nextId = 1;
			this.pending = new Map();
			this.assetMap = null;
			this.replay = []; // mount/writeFiles messages, re-sent if the worker is restarted
			this.startWorker();
		}

		startWorker() {
			this.ready = new Promise((resolve, reject) => {
				this.worker = new Worker(this.baseURL + 'pg-worker.js');
				this.worker.onmessage = (event) => {
					const msg = event.data;
					if (msg.type === 'status') this.onStatus(msg.text);
					else if (msg.type === 'ready') {
						this.timing = msg.timing;
						this.config = msg.config ?? {};
						this.onStatus('Ready');
						resolve(msg);
					} else if (msg.type === 'init-error') {
						this.onStatus('Failed to load');
						reject(new Error(msg.error));
					} else {
						const p = this.pending.get(msg.id);
						if (!p) return;
						this.pending.delete(msg.id);
						clearTimeout(p.timer);
						if (msg.type === 'result') p.resolve(msg.result);
						else p.reject(new Error(msg.error));
					}
				};
				this.worker.onerror = (e) => reject(new Error(e.message));
				for (const msg of this.replay) this.worker.postMessage({ id: 0, ...msg });
			});
			const assets = fetch(this.baseURL + 'pg_files/static-assets.json')
				.then((r) => r.json())
				.then((map) => (this.assetMap = map))
				.catch(() => (this.assetMap = {}));
			this.ready = Promise.all([this.ready, assets]).then(([msg]) => msg);
			return this.ready;
		}

		/* Render a problem. Resolves with the result object from PGWasm.pm.
		 * Give either `source` (PG code) or `sourceFilePath` (relative to the
		 * templates directory, e.g. 'Library/Rochester/setDerivatives1/s2_1_3.pg').
		 * With both, `sourceFilePath` is used to find the problem's images etc. */
		render(request) {
			return this.call({ type: 'render', request });
		}

		/* Load files under the templates directory <dir> (e.g. 'Library/') from
		 * <url> (e.g. a copy of the OPL's OpenProblemLibrary directory). */
		mount(dir, url) {
			const msg = { type: 'mount', dir, url: new URL(url, global.location.href).href };
			this.replay.push(msg);
			return this.call(msg);
		}

		/* Write files to the templates directory, e.g. a problem and its images:
		 * writeFiles('local/', { 'p.pg': text, 'pic.png': arrayBuffer }) */
		writeFiles(dir, files) {
			const msg = { type: 'writeFiles', dir, files };
			this.replay.push(msg);
			return this.call(msg);
		}

		async call(message) {
			await this.ready;
			const id = this.nextId++;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					// The problem is probably stuck in an infinite loop: start a fresh worker.
					this.pending.delete(id);
					this.worker.terminate();
					for (const p of this.pending.values()) p.reject(new Error('PG worker restarted'));
					this.pending.clear();
					this.startWorker();
					reject(new Error(`Timeout: the problem took more than ${this.timeout / 1000} seconds to render.`));
				}, this.timeout);
				this.pending.set(id, { resolve, reject, timer });
				this.worker.postMessage({ id, ...message });
			});
		}

		/* Options for render() matching the submit button that was clicked. */
		static actionOptions(action) {
			switch (action) {
				case 'previewAnswers':
					return { showAttemptResults: 0, showFeedback: 1 };
				case 'showCorrectAnswers':
					return { showAttemptResults: 1, showFeedback: 1, showCorrectAnswers: 2, answersAvailable: 1 };
				default: // submitAnswers
					return { showAttemptResults: 1, showFeedback: 1 };
			}
		}

		assetURL(file) {
			if (/^[a-z]+:|^\/\//i.test(file)) return file;
			return this.baseURL + 'pg_files/' + ((this.assetMap && this.assetMap[file]) || file);
		}

		/* Returns a complete HTML document for showing the problem in an iframe
		 * (via srcdoc). Options:
		 *   problemId     included in the messages posted to the parent window
		 *   buttons       which buttons to show (default: preview, submit, show correct answers)
		 *   showScore     show the score summary after a submission (default true)
		 */
		problemPage(result, options = {}) {
			const problemId = options.problemId ?? 'problem';
			const buttons = options.buttons ?? ['previewAnswers', 'submitAnswers', 'showCorrectAnswers'];
			const labels = {
				previewAnswers: 'Preview My Answers',
				submitAnswers: 'Submit Answers',
				showCorrectAnswers: 'Show Correct Answers'
			};
			const css = [this.baseURL + 'vendor/bootstrap/bootstrap.min.css'];
			const seen = new Set();
			for (const f of result.extra_css_files ?? []) {
				if (seen.has(f.file)) continue;
				seen.add(f.file);
				css.push(f.external ? f.file : this.assetURL(f.file));
			}
			const js = [];
			for (const f of result.extra_js_files ?? []) {
				if (seen.has(f.file)) continue;
				seen.add(f.file);
				const attrs = Object.entries(f.attributes ?? {})
					.map(([k, v]) => (v === null || v === undefined ? k : `${k}="${escapeHTML(v)}"`))
					.join(' ');
				js.push(`<script src="${escapeHTML(f.external ? f.file : this.assetURL(f.file))}" ${attrs}></script>`);
			}

			// Files that PG put in its temp directory (problem images, generated
			// graphs) are given as URLs (the original file's URL, or a data URL).
			let body = result.body_text ?? '';
			let head = (result.head_text ?? '') + (result.post_header_text ?? '');
			for (const [name, url] of Object.entries(result.files ?? {})) {
				body = body.split('pg_temp/' + name).join(url);
				head = head.split('pg_temp/' + name).join(url);
			}

			let summary = '';
			if (result.submitted && (options.showScore ?? true) && result.score !== null && result.score !== undefined) {
				const pct = Math.round(result.score * 100);
				const cls = pct === 100 ? 'success' : pct > 0 ? 'warning' : 'danger';
				summary = `<div class="alert alert-${cls} py-2 mb-2" id="pg-score" data-score="${result.score}">` +
					(result.summary ? `${result.summary}` : '') +
					`<div>You received a score of <b>${pct}%</b> for this attempt.</div></div>`;
			}
			const messages = [];
			if (result.errors) messages.push(`<div class="alert alert-danger"><h3 class="fs-6">Translator errors</h3><pre class="mb-0">${escapeHTML(result.errors)}</pre></div>`);
			if (result.warnings) messages.push(`<div class="alert alert-warning"><h3 class="fs-6">Warnings</h3><pre class="mb-0">${escapeHTML(result.warnings)}</pre></div>`);

			return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base href="${escapeHTML(this.baseURL)}">
${css.map((href) => `<link rel="stylesheet" href="${escapeHTML(href)}">`).join('\n')}
<style>body{padding:.5rem;background:transparent} .problem-content{margin-bottom:1rem}</style>
<script>${MATHJAX_CONFIG}</script>
<script src="${this.baseURL}vendor/mathjax/tex-chtml.js" id="MathJax-script" defer></script>
<script src="${this.baseURL}vendor/bootstrap/bootstrap.bundle.min.js" defer></script>
${js.join('\n')}
${head}
</head>
<body>
${summary}
<form id="problemMainForm" class="problem-main-form" name="problemMainForm" method="POST" action="#">
<div id="problem_body" class="problem-content">${body}</div>
<div class="submit-buttons-container">
${buttons.map((b) => `<input type="submit" name="${b}" value="${labels[b]}" class="btn btn-primary mb-1 me-1">`).join('\n')}
</div>
</form>
${messages.join('\n')}
<script>
(function () {
	var problemId = ${JSON.stringify(problemId)};
	// Registered on the document (not the form), so that it runs after PG's own
	// submit handlers (e.g. MathQuill) have updated the form fields.
	document.addEventListener('submit', function (e) {
		e.preventDefault();
		var form = e.target, data = new FormData(form), inputs = {};
		data.forEach(function (value, key) {
			if (typeof value !== 'string') return;
			if (key in inputs) inputs[key] += '\\0' + value; else inputs[key] = value;
		});
		var action = e.submitter && e.submitter.name ? e.submitter.name : 'submitAnswers';
		inputs[action] = 1;
		parent.postMessage({ type: 'pg-submit', problemId: problemId, inputs: inputs, action: action }, '*');
	});
	function postHeight() {
		parent.postMessage({ type: 'pg-resize', problemId: problemId,
			height: Math.ceil(document.documentElement.getBoundingClientRect().height) }, '*');
	}
	new ResizeObserver(postHeight).observe(document.documentElement);
	window.addEventListener('load', function () {
		postHeight();
		parent.postMessage({ type: 'pg-loaded', problemId: problemId }, '*');
	});
})();
</script>
</body>
</html>`;
		}
	}

	// MathJax configuration, as used by webwork2 and the PG renderer.
	const MATHJAX_CONFIG = `
window.MathJax = {
	tex: { packages: { '[+]': ['noerrors'] }, processEscapes: false },
	loader: { load: ['input/asciimath', '[tex]/noerrors'] },
	startup: {
		ready: function () {
			var AM = MathJax.InputJax.AsciiMath.AM;
			for (var i = 0; i < AM.symbols.length; i++) {
				if (AM.symbols[i].input == '**')
					AM.symbols[i] = { input: '**', tag: 'msup', output: '^', tex: null, ttype: AM.TOKEN.INFIX };
			}
			return MathJax.startup.defaultReady();
		}
	},
	options: {
		renderActions: {
			findScript: [10, function (doc) {
				document.querySelectorAll('script[type^="math/tex"]').forEach(function (node) {
					var display = !!node.type.match(/; *mode=display/);
					var math = new doc.options.MathItem(node.textContent, doc.inputJax[0], display);
					var text = document.createTextNode('');
					node.parentNode.replaceChild(text, node);
					math.start = { node: text, delim: '', n: 0 };
					math.end = { node: text, delim: '', n: 0 };
					doc.math.push(math);
				});
			}, '']
		},
		ignoreHtmlClass: 'tex2jax_ignore'
	}
};`;

	global.PGClient = PGClient;
})(window);
