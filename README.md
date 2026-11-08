# WeBWorK PG in the browser (WebAssembly)

Render and grade [WeBWorK](https://openwebwork.org) problems entirely in the
browser, with no Perl server. The real PG problem renderer runs on Perl
compiled to WebAssembly with [WebPerl](https://github.com/haukex/webperl).
After the first visit it also works offline.

- **PG is unmodified.** `pg/` is the upstream
  [openwebwork/pg](https://github.com/openwebwork/pg) repository. Modules that
  can't work in a browser are replaced in `pg-wasm/perl-lib/`: a pure-Perl `GD`
  (for legacy graphs), and small stand-ins for `DBI` and `YAML::XS`.
- **The Open Problem Library works**, including problem images, legacy GD
  graphs and TikZ pictures. Problem files are loaded on demand, from a copy of
  the OPL bundled with the site (offline) or from GitHub.
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
| `pg-wasm/perl-lib/GD.pm` | Pure-Perl implementation of the GD graphics API PG uses (with libgd's bitmap fonts in `GD/Fonts.pm`) |
| `pg-wasm/perl-lib/{DBI,YAML/XS}.pm` | Stand-ins for modules that can't run in a browser |
| `pg-wasm/pg_config.yml` | PG configuration for the browser (paths in the virtual file system) |
| `pg-wasm/web/pg-engine.js` | Boots Perl + PG (in a Worker or node), renders problems |
| `pg-wasm/web/pg-worker.js` | Web Worker that hosts the engine |
| `pg-wasm/web/pg-client.js` | Page-side API: `render()`, and builds the problem page for an iframe |
| `pg-wasm/web/index.html`, `app.js` | Demo: problem editor + rendered problem |
| `pg-wasm/web/sw.js` | Service worker: caches the whole app for offline use |
| `pg-wasm/problems/` | Extra sample problems (PG's own `tutorial/sample-problems` are included too) |
| `pg-wasm/tools/opl-index.js` | Builds the problem library index (subject → chapter → section) |
| `pg-wasm/test/` | Node test (sample problems, random OPL samples) and Playwright browser test |

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

To include the Open Problem Library for offline use (adds about 300 MB):

```bash
pg-wasm/build.sh --opl            # clones the OPL into work/opl, or set OPL_DIR to a clone
```

Without `--opl`, problems from the library are loaded from GitHub
(raw.githubusercontent.com) on demand, which needs an internet connection, and
the library browser isn't available (problems can still be opened by path).
`--opl-remote` builds the browsable index but still loads problems from GitHub,
and `--opl-contrib` also bundles the OPL's Contrib directory (1.1 GB).

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
OPL_DIR=../work/opl node test/node-render.test.js --opl=1000   # 1000 random OPL problems
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

Instead of `source`, a request can give `sourceFilePath`, a path in the
templates directory such as `Library/Rochester/setDerivatives1/c1s5p8.pg`. With
`source`, `sourceFilePath` tells PG where to find the problem's images. Other
locations can be mounted, and files can be written (e.g. a problem and its
images that a user opened):

```js
await pg.mount('mybook/', 'https://example.org/my-problems/');  // templates/mybook/... loads from that URL
await pg.writeFiles('local/', { 'p.pg': sourceText, 'pic.png': arrayBuffer });
await pg.render({ sourceFilePath: 'local/p.pg' });
```

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
5. **Problem files on demand.** `/opt/templates` is a webwork2-style course
   templates directory, where `Library/` (the OPL), `Contrib/` and `problems/`
   are mounted from URLs (see `dist/pg-wasm-config.json`). When PG looks for a
   file there (a problem, an included problem, a macro, an image), the worker
   fetches it synchronously, which workers are allowed to do, and saves it in
   the in-memory file system. Images that PG links into its temp directory are
   shown from their original URL.
6. **Graphs and pictures.**
   - Legacy WWPlot/`init_graph` graphs (about 6% of the OPL) are drawn by
     `perl-lib/GD.pm`, a pure-Perl implementation of the GD calls PG uses,
     which produces the same PNGs as libgd.
   - TikZ and LaTeX images (`createTikZImage`, `createLaTeXImage`, and the
     `Plots` macros' TikZ output): `PGWasm.pm` replaces `LaTeXImage::draw`,
     so instead of running latex, the image holds a description of the LaTeX
     document. The page compiles it to SVG with
     [TikZJax](https://github.com/drgrice1/tikzjax) (TeX compiled to
     WebAssembly, by Jim Fowler and Glenn Rice). The SVGs are cached in the
     browser, so a picture is only compiled once.
7. **Display.** The result is shown as a full HTML page in an iframe (like
   the PG renderer's iframe mode), with Bootstrap, MathJax and PG's own
   JavaScript (MathQuill, feedback popovers, graph tools, drag and drop).
   Form submissions are sent to the parent page via `postMessage`, and the
   problem is rendered again with the answers to grade them.

## Status and limitations

- **PG's 166 sample problems:** all render. Two show a message instead of one
  of their pictures: one needs a LaTeX package TikZJax doesn't have (xy-pic),
  and `AskSage` needs a Sage server.
- **OPL:** in a random sample of 1,000 OPL problems, 981 render with no errors
  or warnings. The 19 others also fail with native Perl and the same PG: they
  use old applets, call macros with missing options, or use Rserve.
- **TikZ/LaTeX pictures** compile in about 2–5 s the first time (in the
  background, while the rest of the problem is already shown), and are
  instant after that. Only the LaTeX packages TikZJax includes can be used
  (amsmath/amssymb, array, etoolbox, pgfplots, tikz-cd, tikz-3dplot, xparse,
  and all TikZ libraries). For others, a message is shown in place of the
  picture.
- Some OPL problems need course-specific macro files that aren't in the OPL or
  PG (e.g. 39 Portland CC problems load `ORCCA.pl`). They fail on any WeBWorK
  server without that file. Such files can be added to `/opt/templates/macros`
  with `pg.writeFiles('macros/', ...)` or by mounting `macros/`.
- `images` display mode (dvipng) is not available. MathJax mode is used.
- Infinite loops in a problem are stopped by terminating the worker after
  30 s (`PGClient` `timeout` option). The worker then restarts.
- Offline use needs the page to be served over http(s) once, so the service
  worker can cache it. `file://` URLs don't support Web Workers or WebAssembly
  fetches in most browsers. Problems from the library are cached as they're
  used; with `--opl` the whole library is on the same server, so it can be
  used on a local network without internet.
- Download size: about 30 MB uncompressed before any problems are loaded
  (`emperl.wasm` 4.5 MB, `emperl.data` 14 MB, `pg.data` 3.9 MB, TikZJax 7 MB,
  loaded only when a problem has a TikZ picture), less with gzip/brotli on the
  server.
