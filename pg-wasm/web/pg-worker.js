/* Web Worker that hosts the PG engine (Perl + PG in WebAssembly).
 *
 * Messages in:  { id, type: 'render', request }
 * Messages out: { type: 'status', text }
 *               { type: 'ready', timing, bootMessages }
 *               { type: 'init-error', error }
 *               { id, type: 'result', result } or { id, type: 'error', error }
 *
 * Rendering runs synchronously in this worker, so the page stays responsive.
 * If a problem loops forever, the page can terminate this worker and start a
 * new one.
 */
'use strict';

const baseURL = self.location.href.replace(/[^/]*$/, '');
importScripts(baseURL + 'pg-engine.js');

const engine = new PGEngine({
	baseURL,
	loadScript: (url) => importScripts(url),
	onStatus: (text) => self.postMessage({ type: 'status', text })
});

const ready = engine.init().then(
	(timing) => self.postMessage({ type: 'ready', timing, bootMessages: engine.bootMessages }),
	(err) => {
		self.postMessage({ type: 'init-error', error: String(err && err.stack ? err.stack : err) });
		throw err;
	}
);

self.onmessage = async (event) => {
	const { id, type, request } = event.data;
	try {
		await ready;
		if (type !== 'render') throw new Error('Unknown message type ' + type);
		self.postMessage({ id, type: 'result', result: engine.render(request) });
	} catch (err) {
		self.postMessage({ id, type: 'error', error: String(err && err.stack ? err.stack : err) });
	}
};
