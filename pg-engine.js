/* PG engine: runs WeBWorK's PG problem renderer in Perl compiled to WebAssembly.
 *
 * Works in a Web Worker (see pg-worker.js) and in node (see test/).
 *
 *   const engine = new PGEngine({ baseURL: './', loadScript: importScripts,
 *       fetchSync: (url) => Uint8Array | null,
 *       mounts: { 'Library/': 'opl/OpenProblemLibrary/', 'Contrib/': 'opl/Contrib/' } });
 *   await engine.init();
 *   const result = engine.render({ source: '...pg source...', problemSeed: 1234, inputs: {} });
 *   const result = engine.render({ sourceFilePath: 'Library/Rochester/setDerivatives1/s2_1_3.pg' });
 *
 * How it works:
 *  - emperl.js/.wasm/.data is Perl (built by WebPerl); pg.data contains PG's
 *    lib/ and macros/ (mounted at /opt/pg).
 *  - init() runs `perl -e 'use PGWasm'`, which compiles all PG modules and
 *    macros/PG.pl into a cached Safe compartment (like PG's standalone renderer).
 *    The Perl interpreter stays alive after main() returns.
 *  - After that, a copy of the WebAssembly memory is saved. Before every render
 *    the memory is restored from that copy, so each render starts from the same
 *    clean state, without anything left over from previously rendered problems.
 *    This is the in-browser equivalent of the renderer forking a process per
 *    request, and it means a problem only pays for its own translation.
 *  - /opt/templates is a webwork2-style course templates directory. Its
 *    subdirectories can be "mounted" from URLs (e.g. Library/ from a copy of
 *    the OPL): when PG looks for a file there that isn't loaded yet (a problem,
 *    a macro, an image, an included problem), it is fetched synchronously
 *    (allowed in workers) and saved in the in-memory file system. Fetched files
 *    are kept for later renders (the file system lives outside of the
 *    WebAssembly memory, so it isn't affected by the snapshot).
 */
(function (global) {
	'use strict';

	const TEMPLATES = '/opt/templates/';
	const TEMP_DIR = '/tmp/pg/';
	const ENOENT = 44; // Emscripten's errno value

	const mimeType = (name) => {
		const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
		return { svg: 'image/svg+xml', png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg',
			html: 'text/html', htm: 'text/html', pdf: 'application/pdf', js: 'text/javascript', css: 'text/css',
			txt: 'text/plain', csv: 'text/csv', ggb: 'application/octet-stream' }[ext] ?? 'application/octet-stream';
	};

	const toBase64 = (bytes) => {
		if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
		let s = '';
		for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		return btoa(s);
	};

	const normalizePath = (path) => {
		const out = [];
		for (const part of path.split('/')) {
			if (part === '..') out.pop();
			else if (part && part !== '.') out.push(part);
		}
		return '/' + out.join('/');
	};

	class PGEngine {
		constructor(options = {}) {
			this.baseURL = options.baseURL ?? '';
			this.loadScript = options.loadScript;
			this.fetchSync = options.fetchSync ?? null;
			this.useSnapshot = options.useSnapshot ?? true;
			this.onStatus = options.onStatus ?? (() => {});
			this.mounts = [];
			this.missing = new Set(); // files known not to exist (negative cache)
			for (const [dir, url] of Object.entries(options.mounts ?? {})) this.mount(dir, url);
			this.stdout = [];
			this.stderr = [];
			this.snapshot = null;
			this.ready = false;
			this.fetched = new Map(); // virtual path -> URL, for files loaded from mounts
			this.fetchCount = 0;
		}

		/* Make files under /opt/templates/<dir> load on demand from <url>.
		 * In node, <url> may be a local directory. */
		mount(dir, url) {
			dir = dir.replace(/^\/+/, '').replace(/\/*$/, '/');
			url = url.replace(/\/*$/, '/');
			this.mounts = this.mounts.filter((m) => m.dir !== TEMPLATES + dir);
			this.mounts.push({ dir: TEMPLATES + dir, url });
			this.mounts.sort((a, b) => b.dir.length - a.dir.length); // most specific first
			this.missing.clear();
		}

		/* Write files into the virtual file system, e.g. a problem and its images
		 * that the user opened: writeFiles('local/myproblem/', { 'p.pg': bytes, 'pic.png': bytes }).
		 * Paths are relative to /opt/templates. */
		writeFiles(dir, files) {
			const FS = this.Module.FS;
			for (const [name, data] of Object.entries(files)) {
				const path = normalizePath(TEMPLATES + dir + '/' + name);
				if (!path.startsWith(TEMPLATES)) throw new Error('Invalid path ' + name);
				FS.mkdirTree(path.replace(/\/[^/]*$/, ''));
				FS.writeFile(path, typeof data === 'string' ? data : new Uint8Array(data));
				this.missing.delete(path);
			}
		}

		// Loads a file from a mount into the file system. Returns true on success.
		loadFromMount(path) {
			if (!this.fetchSync || this.missing.has(path)) return false;
			const mount = this.mounts.find((m) => path.startsWith(m.dir));
			if (!mount) return false;
			const rel = path.slice(mount.dir.length);
			// Only fetch things that look like files (OPL files all have an extension).
			// This avoids requests for directories while paths are looked up.
			const base = rel.replace(/.*\//, '');
			if (!rel || !/\.[A-Za-z0-9]+$/.test(base)) return false;
			// loadMacros looks in the problem's directory first. Don't ask the server
			// for PG's own macro files there (a problem could override them, but in
			// practice that doesn't happen, and it saves many requests).
			if (this.pgMacroNames.has(base)) return false;
			const url = mount.url + rel.split('/').map(encodeURIComponent).join('/');
			this.fetchCount++;
			let data = null;
			try {
				data = this.fetchSync(url);
			} catch (e) {
				data = null;
			}
			if (!data) {
				this.missing.add(path);
				return false;
			}
			const FS = this.Module.FS;
			this.inLoader = true;
			try {
				FS.mkdirTree(path.replace(/\/[^/]*$/, ''));
				FS.writeFile(path, data);
			} finally {
				this.inLoader = false;
			}
			this.fetched.set(path, url);
			return true;
		}

		// Names of all files below a directory in the virtual file system.
		listFiles(dir, names = new Set()) {
			const FS = this.Module.FS;
			for (const name of FS.readdir(dir)) {
				if (name === '.' || name === '..') continue;
				if (FS.isDir(FS.stat(dir + '/' + name).mode)) this.listFiles(dir + '/' + name, names);
				else names.add(name);
			}
			return names;
		}

		installLoader() {
			const FS = this.Module.FS;
			const lookupPath = FS.lookupPath;
			const tryLoad = (path) => {
				if (this.inLoader) return false;
				const abs = normalizePath(path.startsWith('/') ? path : FS.cwd() + '/' + path);
				return abs.startsWith(TEMPLATES) && this.loadFromMount(abs);
			};
			FS.lookupPath = (path, opts = {}) => {
				let result;
				try {
					result = lookupPath.call(FS, path, opts);
				} catch (e) {
					if (!e || e.errno !== ENOENT || opts.parent || !tryLoad(path)) throw e;
					return lookupPath.call(FS, path, opts);
				}
				// With noent_okay (used when opening files), a missing file gives no node.
				if (opts.noent_okay && !result.node && !opts.parent && tryLoad(path))
					return lookupPath.call(FS, path, opts);
				return result;
			};
		}

		async init() {
			const t0 = Date.now();
			this.onStatus('Loading Perl and PG...');
			// WebPerl.xs refers to a global Perl object (used by its js() function).
			if (!global.Perl) global.Perl = { trace: false, glue: () => { throw new Error('WebPerl js() is not supported here'); } };

			await new Promise((resolve, reject) => {
				global.Module = {
					noInitialRun: true,
					locateFile: (file) => this.baseURL + file,
					print: (text) => this.stdout.push(text),
					printErr: (text) => this.stderr.push(text),
					onRuntimeInitialized: resolve,
					onAbort: (what) => reject(new Error('Perl aborted: ' + what))
				};
				try {
					this.loadScript(this.baseURL + 'pg.data.js');
					this.loadScript(this.baseURL + 'emperl.js');
				} catch (e) {
					reject(e);
				}
			});
			this.Module = global.Module;
			this.pgMacroNames = this.listFiles('/opt/pg/macros');
			this.installLoader();
			this.timing = { runtime: Date.now() - t0 };

			this.onStatus('Compiling PG...');
			const t1 = Date.now();
			this.stderr.length = 0;
			const status = this.Module.callMain(['-e', 'use PGWasm; 1']);
			if (status) throw new Error('Loading PG failed:\n' + this.stderr.join('\n'));
			this.timing.pgLoad = Date.now() - t1;
			this.bootMessages = this.stderr.splice(0);

			if (this.useSnapshot) {
				this.snapshot = new Uint8Array(this.Module.wasmMemory.buffer).slice();
				this.timing.snapshotBytes = this.snapshot.length;
			}
			this.ready = true;
			this.onStatus('Ready');
			return this.timing;
		}

		/* Render (and grade, if inputs are given) a problem.
		 * request: { source | sourceFilePath, problemSeed, inputs, showSolutions,
		 *            showHints, showCorrectAnswers, ... } (see perl-lib/PGWasm.pm) */
		render(request) {
			if (!this.ready) throw new Error('PGEngine is not initialized');
			const t0 = Date.now();
			const fetches = this.fetchCount;
			if (this.snapshot) new Uint8Array(this.Module.wasmMemory.buffer).set(this.snapshot);
			this.stdout.length = 0;
			this.stderr.length = 0;
			const reqFile = '/tmp/pg_request.json';
			this.Module.FS.writeFile(reqFile, JSON.stringify(request));
			const out = this.Module.ccall('webperl_eval_perl', 'string', ['string'],
				[`PGWasm::render_file('${reqFile}')`]);
			let result;
			try {
				result = JSON.parse(out);
			} catch (e) {
				result = { errors: 'Invalid response from PG: ' + e + '\n' + out, body_text: '', answers: {} };
			}
			result.files = this.resolveFiles(result.files ?? {});
			if (this.stderr.length) result.stderr = this.stderr.join('\n');
			result.fetches = this.fetchCount - fetches;
			result.renderTime = Date.now() - t0;
			return result;
		}

		// Converts the files PG put in its temp directory into URLs for the page:
		// links to fetched files use the original URL, other files become data URLs,
		// and TikZ/LaTeX images become { latex: description } objects.
		// TikZ/LaTeX images: PGWasm.pm replaces the image by a description of the
		// LaTeX document, which the page compiles with TikZJax (see pg-client.js).
		readLatexImage(path) {
			const marker = '%PGWASM-LATEX%\n';
			try {
				const data = this.Module.FS.readFile(path);
				if (data.length < marker.length || new TextDecoder().decode(data.subarray(0, marker.length)) !== marker)
					return null;
				return JSON.parse(new TextDecoder().decode(data.subarray(marker.length)));
			} catch (e) {
				return null;
			}
		}

		resolveFiles(files) {
			const urls = {};
			let latex;
			for (const [name, info] of Object.entries(files)) {
				const target = info.link ? normalizePath(info.link.startsWith('/') ? info.link : TEMP_DIR + info.link) : null;
				if (target && this.fetched.has(target)) urls[name] = this.fetched.get(target);
				else if (!target && (latex = this.readLatexImage(info.path))) urls[name] = { latex };
				else {
					try {
						urls[name] = `data:${mimeType(name)};base64,${toBase64(this.Module.FS.readFile(target ?? info.path))}`;
					} catch (e) {
						/* unreadable file: leave it out */
					}
				}
			}
			return urls;
		}
	}

	global.PGEngine = PGEngine;
	if (typeof module === 'object' && module.exports) module.exports = PGEngine;
})(typeof globalThis !== 'undefined' ? globalThis : self);
