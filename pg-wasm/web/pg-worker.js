/* Web Worker that hosts the PG engine (Perl + PG in WebAssembly).
 *
 * Messages in:  { id, type: 'render', request }
 *               { id, type: 'mount', dir, url }          files under /opt/templates/<dir> load from <url>
 *               { id, type: 'writeFiles', dir, files }   write files (name -> ArrayBuffer|string)
 * Messages out: { type: 'status', text }
 *               { type: 'ready', timing, bootMessages, mounts }
 *               { type: 'init-error', error }
 *               { id, type: 'result', result } or { id, type: 'error', error }
 *
 * Default mounts come from pg-wasm-config.json (written by the build).
 * Rendering runs synchronously in this worker, so the page stays responsive.
 * If a problem loops forever, the page can terminate this worker and start a
 * new one.
 */
'use strict';

const baseURL = self.location.href.replace(/[^/]*$/, '');
importScripts(baseURL + 'pg-engine.js');

// Synchronous binary fetch (allowed in workers). Returns null if not found.
const fetchSync = (url) => {
	const xhr = new XMLHttpRequest();
	xhr.open('GET', url, false);
	xhr.responseType = 'arraybuffer';
	try {
		xhr.send();
	} catch (e) {
		return null;
	}
	if (xhr.status !== 200 && xhr.status !== 0) return null;
	if (!xhr.response || (xhr.status === 0 && xhr.response.byteLength === 0)) return null;
	return new Uint8Array(xhr.response);
};

let config = {};
try {
	const data = fetchSync(baseURL + 'pg-wasm-config.json');
	if (data) config = JSON.parse(new TextDecoder().decode(data));
} catch (e) {
	console.warn('pg-wasm-config.json:', e);
}
const absolute = (url) => new URL(url, baseURL).href;

const engine = new PGEngine({
	baseURL,
	fetchSync,
	loadScript: (url) => importScripts(url),
	onStatus: (text) => self.postMessage({ type: 'status', text })
});
for (const [dir, url] of Object.entries(config.mounts ?? {})) engine.mount(dir, absolute(url));

const ready = engine.init().then(
	(timing) => self.postMessage({ type: 'ready', timing, bootMessages: engine.bootMessages, config }),
	(err) => {
		self.postMessage({ type: 'init-error', error: String(err && err.stack ? err.stack : err) });
		throw err;
	}
);

self.onmessage = async (event) => {
	const { id, type } = event.data;
	try {
		let result;
		if (type === 'mount') {
			engine.mount(event.data.dir, absolute(event.data.url));
		} else {
			await ready;
			if (type === 'render') result = engine.render(event.data.request);
			else if (type === 'writeFiles') engine.writeFiles(event.data.dir, event.data.files);
			else throw new Error('Unknown message type ' + type);
		}
		self.postMessage({ id, type: 'result', result });
	} catch (err) {
		self.postMessage({ id, type: 'error', error: String(err && err.stack ? err.stack : err) });
	}
};
