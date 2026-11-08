# WeBWorK PG in the browser (WebAssembly)

Render and grade [WeBWorK](https://openwebwork.org) problems entirely in the
browser, with no Perl server. The real PG problem renderer runs on Perl
compiled to WebAssembly with [WebPerl](https://github.com/haukex/webperl).
After the first visit it also works offline.

- **PG is unmodified.** `pg/` is the upstream
  [openwebwork/pg](https://github.com/openwebwork/pg) repository. The only
  substitutions are small stand-ins for three CPAN modules that can't work in a
  browser (`GD`, `DBI`, `YAML::XS`, see `pg-wasm/perl-lib/`).
- **WebPerl was updated** for current Emscripten and Perl 5.40.3 (`webperl/`,
  branch `claude/gracious-fermi-oy6dr4` of jaltekruse/webperl). It no longer
  needs a fork of Perl.
- Rendering a problem takes about 100–300 ms after a one-time startup of
  about 1 s.

## Layout

| Path | What it is |
|---|---|
| `webperl/` | Submodule: WebPerl, builds Perl → `emperl.js/.wasm/.data` |
| `pg/` | Submodule: upstream PG (problem renderer, macros, client-side JS) |
| `pg-wasm/build.sh` | Builds everything into `pg-wasm/dist/` |
| `pg-wasm/perl-lib/PGWasm.pm` | Perl side of the bridge: JSON request → `WeBWorK::PG` → JSON result |
| `pg-wasm/perl-lib/{GD,DBI,YAML/XS}.pm` | Stand-ins for modules that can't run in a browser |
| `pg-wasm/web/pg-engine.js` | Boots Perl + PG (in a Worker or node), renders problems |
| `pg-wasm/web/pg-worker.js` | Web Worker that hosts the engine |
| `pg-wasm/web/pg-client.js` | Page-side API: `render()`, and builds the problem page for an iframe |
| `pg-wasm/web/index.html`, `app.js` | Demo: problem editor + rendered problem |
| `pg-wasm/web/sw.js` | Service worker: caches the whole app for offline use |
| `pg-wasm/problems/` | Extra sample problems (PG's own `tutorial/sample-problems` are included too) |
| `pg-wasm/test/` | Node test (renders all sample problems) and Playwright browser test |

## Building

Requirements: Linux or macOS with bash, curl, make, a C compiler, perl,
python3, node + npm, and the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html).

```bash
git clone --recurse-submodules <this repo>
cd webwork-wasm
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
~/emsdk/emsdk install latest && ~/emsdk/emsdk activate latest
export EMSDK=~/emsdk
pg-wasm/build.sh
```

The first build takes about 5–10 minutes: it downloads Perl and the CPAN
modules, builds a native host miniperl, then cross-compiles Perl. Later builds
reuse that work; `pg-wasm/build.sh --skip-perl` only repackages PG and the
front end.

Try it:

```bash
node pg-wasm/tools/serve.js pg-wasm/dist 8080
```

then open <http://localhost:8080/>. `pg-wasm/dist/` is a static site: it can be
copied to any web server, GitHub Pages, or a USB stick with a small local
server.

Tests:

```bash
cd pg-wasm
node test/node-render.test.js --all   # renders all ~170 sample problems in node
node test/browser.test.js             # Chromium via Playwright, writes test/screenshots/
```

## Embedding problems in your own page

```html
<script src="pg-client.js"></script>
<iframe id="p1"></iframe>
<script>
	const pg = new PGClient({ baseURL: 'path/to/dist/' });
	const source = `DOCUMENT(); ... ENDDOCUMENT();`;   // or fetch a .pg file
	const show = async (inputs, action) => {
		const result = await pg.render({ source, problemSeed: 42, inputs: inputs ?? {},
			...(inputs ? PGClient.actionOptions(action) : {}) });
		document.getElementById('p1').srcdoc = pg.problemPage(result, { problemId: 'p1' });
		return result;  // result.score, result.answers[label].score, ...
	};
	window.addEventListener('message', (e) => {
		if (e.data?.type === 'pg-submit' && e.data.problemId === 'p1') show(e.data.inputs, e.data.action);
		if (e.data?.type === 'pg-resize' && e.data.problemId === 'p1') document.getElementById('p1').style.height = e.data.height + 'px';
	});
	show();
</script>
```

The request options (`problemSeed`, `inputs`, `showHints`, `showSolutions`,
`showCorrectAnswers`, `language`, ...) map onto `WeBWorK::PG->new` options; see
`pg-wasm/perl-lib/PGWasm.pm`.

## How it works

1. **Perl in WebAssembly.** `webperl/build/build.sh` downloads Perl 5.40.3,
   builds a native miniperl for build-time scripts, and cross-compiles Perl
   with emcc. XS modules (`Cpanel::JSON::XS`, `HTML::Parser`, plus core ones like
   `Opcode`, which PG's `Safe` sandbox needs) are linked in statically.
   Pure-Perl dependencies (Mojolicious, Class::Accessor, Tie::IxHash, ...)
   are bundled in `emperl.data`.
2. **PG packaging.** PG's `lib/` and `macros/` go into `pg.data`, mounted at
   `/opt/pg` in Emscripten's in-memory file system. PG's config YAML is
   converted to JSON at build time.
3. **Load once, render many.** In a Web Worker, `perl -e 'use PGWasm'` loads
   PG the way the standalone renderer does (`MOJO_MODE`): all modules and
   `PG.pl` are compiled once into a cached `Safe` compartment. The
   interpreter stays alive, and the worker saves a copy of the WebAssembly
   memory.
4. **Fresh state per render.** Before each render, the worker restores the
   saved memory. This is the in-browser version of the renderer forking a
   new process per request: no state leaks from one problem to the next, and
   a crash during one render doesn't affect the next.
5. **Display.** The result is shown as a full HTML page in an iframe (like
   the PG renderer's iframe mode), with Bootstrap, MathJax and PG's own
   JavaScript (MathQuill, feedback popovers, graph tools, drag and drop).
   Form submissions are sent to the parent page via `postMessage`, and the
   problem is rendered again with the answers to grade them.

## Status and limitations

- 151 of PG's 166 sample problems render with no errors or warnings. The others:
  - **TikZ/LaTeX images** (`createTikZImage`, `createLaTeXImage`; 13 samples)
    need a TeX installation. These problems render, but the image is missing.
    Problems using the `Plots` macros (JSXGraph) work. A possible next step is
    a WebAssembly TeX engine (e.g. TikZJax/SwiftLaTeX).
  - **Legacy GD graphs** (`init_graph`/WWPlot; 1 sample) need libgd. A
    possible next step is a pure-Perl GD replacement that draws PNG/SVG.
  - **Sage cells** (`AskSage`) need a Sage server and network access.
- Images that live next to a problem file (e.g. OPL problems with
  `image("foo.png")`) aren't provided to the renderer yet.
- `images` display mode (dvipng) is not available. MathJax mode is used.
- Infinite loops in a problem are stopped by terminating the worker after
  30 s (`PGClient` `timeout` option). The worker then restarts.
- Offline use needs the page to be served over http(s) once, so the service
  worker can cache it. `file://` URLs don't support Web Workers or WebAssembly
  fetches in most browsers.
- Download size: about 23 MB uncompressed (`emperl.wasm` 4.5 MB,
  `emperl.data` 14 MB, `pg.data` 3.9 MB), less with gzip/brotli on the server.
  `emperl.data` could be trimmed further, e.g. unused parts of `unicore` and Mojolicious.
