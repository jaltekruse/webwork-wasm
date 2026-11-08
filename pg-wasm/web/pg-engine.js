/* PG engine: runs WeBWorK's PG problem renderer in Perl compiled to WebAssembly.
 *
 * Works in a Web Worker (see pg-worker.js) and in node (see test/).
 *
 *   const engine = new PGEngine({ baseURL: './', loadScript: importScripts });
 *   await engine.init();
 *   const result = engine.render({ source: '...pg source...', problemSeed: 1234, inputs: {} });
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
 */
(function (global) {
	'use strict';

	class PGEngine {
		constructor(options = {}) {
			this.baseURL = options.baseURL ?? '';
			this.loadScript = options.loadScript;
			this.useSnapshot = options.useSnapshot ?? true;
			this.onStatus = options.onStatus ?? (() => {});
			this.stdout = [];
			this.stderr = [];
			this.snapshot = null;
			this.ready = false;
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
		 * request: { source, problemSeed, inputs, showSolutions, showHints,
		 *            showCorrectAnswers, ... } (see perl-lib/PGWasm.pm) */
		render(request) {
			if (!this.ready) throw new Error('PGEngine is not initialized');
			const t0 = Date.now();
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
			if (this.stderr.length) result.stderr = this.stderr.join('\n');
			result.renderTime = Date.now() - t0;
			return result;
		}
	}

	global.PGEngine = PGEngine;
	if (typeof module === 'object' && module.exports) module.exports = PGEngine;
})(typeof globalThis !== 'undefined' ? globalThis : self);
