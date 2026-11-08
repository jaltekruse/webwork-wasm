#!/bin/bash
# Builds the browser version of PG into pg-wasm/dist:
#
#   emperl.js/.wasm/.data   Perl compiled to WebAssembly, with PG's CPAN deps
#   pg.data, pg.data.js     The PG library and macros (mounted at /opt/pg)
#   pg_files/               PG's client-side JavaScript/CSS (from pg/htdocs)
#   vendor/                 Bootstrap and MathJax
#   index.html etc.         The demo front end (from pg-wasm/web)
#   problems/               Sample problems
#
#   opl/                    The Open Problem Library (with --opl)
#   pg-wasm-config.json     Where problem library files are loaded from
#
# Usage: pg-wasm/build.sh [OPTIONS]
#   --skip-perl     Don't rebuild Perl (reuse dist/emperl.*)
#   --reconfig      Passed to webperl/build/build.sh (fresh Perl configure)
#   --opl           Include the Open Problem Library's OpenProblemLibrary
#                   directory (~300 MB) in dist/opl, for offline use, and
#                   build a browsable index of it
#   --opl-contrib   Also include the OPL's Contrib directory (~1.1 GB)
#   --opl-remote    Don't copy the OPL, but still build the index (problems are
#                   loaded from GitHub, so this needs an internet connection)
#
# Without --opl, problems from the library ("Library/..." and "Contrib/...")
# are loaded from GitHub on demand. The OPL is cloned into work/opl, or set
# OPL_DIR to an existing clone of webwork-open-problem-library.
#
# Requirements: everything webperl/build/build.sh needs (Emscripten SDK, node,
# curl, make, a C compiler, perl), plus npm and python3.

set -euo pipefail

HERE="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"
ROOT="$( cd "$HERE/.." && pwd )"
WEBPERL="$ROOT/webperl"
PG="$ROOT/pg"
DIST="$HERE/dist"
WORK="$ROOT/work"

SKIP_PERL=0; WEBPERL_ARGS=(); OPL=none; OPL_CONTRIB=0
OPL_GITHUB="https://raw.githubusercontent.com/openwebwork/webwork-open-problem-library/main"
for arg in "$@"; do
	case "$arg" in
		--skip-perl) SKIP_PERL=1 ;;
		--reconfig)  WEBPERL_ARGS+=(--reconfig) ;;
		--opl)          OPL=copy ;;
		--opl-contrib)  OPL=copy; OPL_CONTRIB=1 ;;
		--opl-remote)   OPL=remote ;;
		*) echo "Unknown option $arg" >&2; exit 1 ;;
	esac
done

say() { echo "=== $*" >&2; }

[ -f "$PG/lib/WeBWorK/PG.pm" ] || { echo "PG not found in $PG (run: git submodule update --init)" >&2; exit 1; }
[ -x "$WEBPERL/build/build.sh" ] || { echo "WebPerl not found in $WEBPERL (run: git submodule update --init)" >&2; exit 1; }

mkdir -p "$DIST" "$WORK"

# ##### Perl + CPAN modules #####

# XS modules are compiled into the WebAssembly binary.
export EMPERL_XS_MODULES="Cpanel::JSON::XS HTML::Parser"
# Pure-Perl modules needed by PG (see pg/cpanfile). GD, DBI and YAML::XS are
# replaced by stand-ins in pg-wasm/perl-lib.
export EMPERL_PP_MODULES="HTML::Tagset Mojolicious Class::Accessor Tie::IxHash UUID::Tiny \
	Locale::Maketext::Lexicon Types::Serialiser common::sense Devel::StackTrace Future"
export EMPERL_EXTRA_LIBS="$HERE/perl-lib"
export EMPERL_WORKDIR="$WORK/webperl"
export EMPERL_DESTDIR="$DIST"

if [ "$SKIP_PERL" = 0 ] || [ ! -f "$DIST/emperl.wasm" ]; then
	say "Building Perl (WebPerl)"
	"$WEBPERL/build/build.sh" "${WEBPERL_ARGS[@]}"
fi

# Emscripten's file packager (for pg.data)
if ! command -v emcc >/dev/null 2>&1; then
	# shellcheck disable=SC1091
	. "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" >/dev/null 2>&1
fi
EMSCRIPTEN_DIR="$(dirname "$(command -v emcc)")"
FILE_PACKAGER="$EMSCRIPTEN_DIR/tools/file_packager.py"
[ -f "$FILE_PACKAGER" ] || FILE_PACKAGER="$EMSCRIPTEN_DIR/tools/file_packager"

# ##### npm dependencies #####

say "Installing npm dependencies"
( cd "$HERE" && npm install --no-audit --no-fund --silent )
if [ ! -f "$PG/htdocs/static-assets.json" ]; then
	say "Building PG's JavaScript assets (pg/htdocs)"
	( cd "$PG/htdocs" && npm ci --no-audit --no-fund --silent )
fi

# ##### PG library -> pg.data #####

say "Packaging the PG library"
STAGE="$WORK/pgstage"
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -r "$PG/lib" "$PG/macros" "$PG/VERSION" "$STAGE/"
mkdir -p "$STAGE/conf"
cp "$PG/conf/pg_config.dist.yml" "$STAGE/conf/"
# Things that are not used for rendering problems
rm -rf "$STAGE/lib/WeBWorK/PG/Critic" "$STAGE/lib/WeBWorK/PG/Critic.pm" "$STAGE/lib/WeBWorK/PG/Tidy.pm" \
	"$STAGE/lib/WeBWorK/PG/ConvertToPGML.pm" "$STAGE/lib/WeBWorK/Utils/PODtoHTML.pm" "$STAGE/lib/WeBWorK/Utils/PODParser.pm"
# The YAML::XS stand-in reads a JSON version of the configuration
node "$HERE/tools/yaml2json.js" "$STAGE/conf/pg_config.dist.yml" "$STAGE/conf/pg_config.dist.yml.json"
if [ -f "$HERE/pg_config.yml" ]; then
	cp "$HERE/pg_config.yml" "$STAGE/conf/pg_config.yml"
	node "$HERE/tools/yaml2json.js" "$STAGE/conf/pg_config.yml" "$STAGE/conf/pg_config.yml.json"
fi
find "$STAGE" -type f \( -name '*.pm' -o -name '*.pl' \) -print0 | xargs -0 perl "$WEBPERL/build/strip_pod.pl"
( cd "$DIST" && python3 "$FILE_PACKAGER" pg.data --preload "$STAGE@/opt/pg" \
	--js-output=pg.data.js --export-name=Module --quiet )

# ##### PG htdocs (client-side JavaScript/CSS used by problems) #####

say "Copying PG's client-side assets"
PGF="$DIST/pg_files"
rm -rf "$PGF"; mkdir -p "$PGF"
cp "$PG/htdocs/static-assets.json" "$PGF/"
( cd "$PG/htdocs" && find js images -type f \( -name '*.min.js' -o -name '*.min.css' -o -name '*.png' \
	-o -name '*.gif' -o -name '*.svg' -o -name '*.jpg' -o -name '*.woff' -o -name '*.woff2' -o -name '*.ttf' \) \
	-exec cp --parents {} "$PGF/" \; )
cp -r "$PG/htdocs/helpFiles" "$PGF/" 2>/dev/null || true
for f in @openwebwork/mathquill/dist jsxgraph/distrib/jsxgraph.css jsxgraph/distrib/jsxgraphcore.js \
		jszip-utils/dist/jszip-utils.min.js jszip/dist/jszip.min.js plotly.js-dist-min/plotly.min.js \
		sortablejs/Sortable.min.js; do
	mkdir -p "$PGF/node_modules/$(dirname "$f")"
	cp -r "$PG/htdocs/node_modules/$f" "$PGF/node_modules/$f"
done

# ##### Third-party libraries for the problem page #####

say "Copying Bootstrap and MathJax"
rm -rf "$DIST/vendor"; mkdir -p "$DIST/vendor/bootstrap" "$DIST/vendor/mathjax"
cp "$HERE/node_modules/bootstrap/dist/css/bootstrap.min.css" "$HERE/node_modules/bootstrap/dist/js/bootstrap.bundle.min.js" \
	"$DIST/vendor/bootstrap/"
( cd "$HERE/node_modules/mathjax/es5" && cp -r tex-chtml.js input output/chtml.js ui a11y adaptors "$DIST/vendor/mathjax/" 2>/dev/null; \
	mkdir -p "$DIST/vendor/mathjax/output/chtml/fonts" && cp -r output/chtml/fonts/woff-v2 "$DIST/vendor/mathjax/output/chtml/fonts/" ) || true
rm -f "$DIST/vendor/mathjax/chtml.js"
mkdir -p "$DIST/vendor/mathjax/output" && cp "$HERE/node_modules/mathjax/es5/output/chtml.js" "$DIST/vendor/mathjax/output/"

# ##### Front end and sample problems #####

say "Copying the front end"
cp -r "$HERE/web/." "$DIST/"
rm -rf "$DIST/problems"; cp -r "$HERE/problems" "$DIST/problems"
# PG's documented sample problems (pg/tutorial/sample-problems)
cp -r "$PG/tutorial/sample-problems" "$DIST/problems/sample-problems"
node "$HERE/tools/problem-index.js" "$DIST/problems" > "$DIST/problems/index.json"

# ##### Problem library #####

rm -rf "$DIST/opl"
LIB_URL="$OPL_GITHUB/OpenProblemLibrary/"; CONTRIB_URL="$OPL_GITHUB/Contrib/"; INDEX=null
if [ "$OPL" != none ]; then
	if [ -z "${OPL_DIR:-}" ]; then
		OPL_DIR="$WORK/opl"
		if [ ! -d "$OPL_DIR/OpenProblemLibrary" ]; then
			say "Cloning the Open Problem Library into $OPL_DIR (about 2 GB)"
			git clone --depth 1 https://github.com/openwebwork/webwork-open-problem-library.git "$OPL_DIR"
		fi
	fi
	[ -d "$OPL_DIR/OpenProblemLibrary" ] || { echo "No OpenProblemLibrary directory in $OPL_DIR" >&2; exit 1; }
	mkdir -p "$DIST/opl"
	INDEX_ROOTS=("Library=$OPL_DIR/OpenProblemLibrary")
	if [ "$OPL" = copy ]; then
		say "Copying the OPL into dist/opl"
		cp -r "$OPL_DIR/OpenProblemLibrary" "$DIST/opl/"
		LIB_URL="opl/OpenProblemLibrary/"
		if [ "$OPL_CONTRIB" = 1 ]; then
			cp -r "$OPL_DIR/Contrib" "$DIST/opl/"
			CONTRIB_URL="opl/Contrib/"
			INDEX_ROOTS+=("Contrib=$OPL_DIR/Contrib")
		fi
	fi
	say "Indexing the problem library"
	node "$HERE/tools/opl-index.js" "$DIST/opl/index.json" "${INDEX_ROOTS[@]}"
	INDEX='"opl/index.json"'
fi
printf '{\n\t"mounts": { "Library/": "%s", "Contrib/": "%s", "problems/": "problems/" },\n\t"libraryIndex": %s\n}\n' \
	"$LIB_URL" "$CONTRIB_URL" "$INDEX" >"$DIST/pg-wasm-config.json"

node "$HERE/tools/make-precache.js" "$DIST"

say "Done. Serve $DIST with any static web server, e.g.: node $HERE/tools/serve.js $DIST"
du -sh "$DIST" "$DIST"/emperl.* "$DIST"/pg.data "$DIST/pg_files" "$DIST/vendor" >&2
