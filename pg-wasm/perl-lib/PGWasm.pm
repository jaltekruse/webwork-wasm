package PGWasm;

# Bridge between JavaScript and PG, for running PG inside WebAssembly Perl.
#
# JavaScript writes a JSON request to a file in the virtual file system and
# calls PGWasm::render_file($path); the result is returned as a JSON string.
#
# PG is set up the same way as in the standalone renderer (MOJO_MODE): all PG
# modules and macros/PG.pl are compiled once, when this module loads, into a
# cached Safe compartment. The JavaScript side takes a snapshot of the
# WebAssembly memory after this module has loaded, and restores it before
# each render, so every render starts from the same clean state (this is the
# browser equivalent of the renderer forking a new process per request).

use strict;
use warnings;

BEGIN {
	$ENV{PG_ROOT}   //= '/opt/pg';
	$ENV{MOJO_MODE} //= 'wasm';
}

use lib "$ENV{PG_ROOT}/lib";

use Cpanel::JSON::XS ();
use Scalar::Util ();
use WeBWorK::PG;

our $VERSION = '0.1';

# Keys of an answer hash that are useful to the front end.
my @ANSWER_KEYS = qw(
	score correct_ans correct_ans_latex_string correct_value student_ans original_student_ans
	preview_latex_string preview_text_string ans_message error_message error_flag type ans_label
);

# Flags that are useful to the front end.
my @FLAG_KEYS = qw(
	ANSWER_ENTRY_ORDER showPartialCorrectAnswers recordSubmittedAnswers solutionExists hintExists
	comment showHintLimit error_flag
);

our $TEMP_DIR     = '/tmp/pg';
our $TEMPLATE_DIR = '/opt/templates/';
mkdir $TEMP_DIR unless -d $TEMP_DIR;
mkdir $TEMPLATE_DIR unless -d $TEMPLATE_DIR;

sub _clear_dir {
	my ($dir) = @_;
	opendir(my $dh, $dir) or return;
	for my $f (grep { !/^\.\.?$/ } readdir $dh) {
		my $p = "$dir/$f";
		if (-d $p && !-l $p) { _clear_dir($p); rmdir $p } else { unlink $p }
	}
	closedir $dh;
	return;
}

# Returns { relative path => { path => ..., link => ... } } for the files
# under $dir. "link" is set for symbolic links (PG links problem images, e.g.
# from the OPL, into the temp directory), so the front end can load them from
# their original location.
sub _collect_files {
	my ($dir, $prefix, $out) = @_;
	$prefix //= '';
	$out    //= {};
	opendir(my $dh, $dir) or return $out;
	for my $f (grep { !/^\.\.?$/ } readdir $dh) {
		my $p = "$dir/$f";
		if (-d $p && !-l $p) { _collect_files($p, "$prefix$f/", $out) }
		elsif (-l $p) { $out->{"$prefix$f"} = { path => $p, link => readlink($p) } }
		elsif (-f $p) {
			_recompress_png($p) if $p =~ /\.png$/i;
			$out->{"$prefix$f"} = { path => $p };
		}
	}
	closedir $dh;
	return $out;
}

# PNG files written by the pure-Perl GD are stored uncompressed (see GD.pm).
sub _recompress_png {
	my ($path) = @_;
	return unless defined &GD::recompress_png;
	open(my $in, '<:raw', $path) or return;
	my $png = do { local $/; <$in> };
	close $in;
	my $small = eval { GD::recompress_png($png) };
	return unless defined $small && length $small < length $png;
	open(my $out, '>:raw', $path) or return;
	print $out $small;
	close $out;
	return;
}

my $json = Cpanel::JSON::XS->new->utf8->canonical->allow_nonref->allow_blessed->convert_blessed;

sub _stringify {
	my $v = shift;
	return undef unless defined $v;
	return "$v" if ref $v && (Scalar::Util::blessed($v) || ref $v eq 'SCALAR');
	return $v;
}

sub render {
	my ($request) = @_;
	my %req = %{$request // {}};

	# The problem is given either as source code, or as a file path relative to
	# the templates directory (e.g. "Library/Rochester/setDerivatives1/s2_1_3.pg").
	my $source = $req{source};
	my $inputs = $req{inputs} // {};
	my $submitted = $req{processAnswers} // (%$inputs ? 1 : 0);

	my %options = (
		(defined $source ? (r_source => \$source) : ()),
		sourceFilePath     => $req{sourceFilePath} // '',
		templateDirectory  => $req{templateDirectory} // $TEMPLATE_DIR,
		displayMode        => $req{displayMode} // 'MathJax',
		problemSeed        => $req{problemSeed} // 1234,
		problemUUID        => $req{problemUUID} // 0,
		psvn               => $req{psvn} // 1,
		processAnswers     => 1,
		inputs_ref         => $inputs,
		language           => $req{language} // 'en',
		showHints          => $req{showHints} // 1,
		showSolutions      => $req{showSolutions} // 0,
		showCorrectAnswers => $req{showCorrectAnswers} // 0,
		isInstructor       => $req{isInstructor} // 0,
		answersAvailable   => $req{answersAvailable} // 0,
		forceScaffoldsOpen => $req{forceScaffoldsOpen} // 0,
		useMathQuill       => $req{useMathQuill} // 1,
		useMathView        => $req{useMathView} // 0,
		showFeedback       => $req{showFeedback} // $submitted,
		showAttemptAnswers => $req{showAttemptAnswers} // 1,
		showAttemptPreviews => $req{showAttemptPreviews} // 1,
		showAttemptResults => $req{showAttemptResults} // $submitted,
		showMessages       => $req{showMessages} // 1,
		forceShowAttemptResults => $req{forceShowAttemptResults} // 0,
		answerPrefix       => $req{answerPrefix} // '',
		num_of_correct_ans   => $req{numCorrect} // 0,
		num_of_incorrect_ans => $req{numIncorrect} // 0,
		recorded_score       => $req{recordedScore} // 0,
		htmlURL            => $req{htmlURL} // 'pg_files/',
		tempURL            => $req{tempURL} // 'pg_temp/',
		tempDirectory      => $TEMP_DIR,
	);

	# Files that PG writes to the temp directory during this render (e.g.
	# images) are returned to the front end.
	_clear_dir($TEMP_DIR);

	my $pg = WeBWorK::PG->new(%options);

	my %answers;
	for my $label (keys %{ $pg->{answers} // {} }) {
		my $ans = $pg->{answers}{$label};
		next unless ref $ans;
		$answers{$label} = { map { $_ => _stringify($ans->{$_}) } grep { exists $ans->{$_} } @ANSWER_KEYS };
	}

	my $flags = $pg->{flags} // {};
	my %result = (
		head_text        => $pg->{head_text},
		post_header_text => $pg->{post_header_text},
		body_text        => $pg->{body_text},
		answers          => \%answers,
		submitted        => $submitted ? Cpanel::JSON::XS::true : Cpanel::JSON::XS::false,
		score            => $submitted ? ($pg->{result}{score} // 0) : undef,
		summary          => $submitted ? $pg->{result}{summary} : undef,
		result_msg       => $pg->{result}{msg},
		state            => $pg->{state},
		errors           => $pg->{errors},
		warnings         => $pg->{warnings},
		flags            => { map { $_ => $flags->{$_} } grep { exists $flags->{$_} } @FLAG_KEYS },
		extra_js_files   => $flags->{extra_js_files} // [],
		extra_css_files  => $flags->{extra_css_files} // [],
	);
	$result{files} = _collect_files($TEMP_DIR);
	$pg->free;
	return \%result;
}

# Called from JavaScript: reads the JSON request from $path, returns JSON.
sub render_file {
	my ($path) = @_;
	my $out = eval {
		open my $fh, '<:raw', $path or die "Can't read request $path: $!\n";
		my $req = $json->decode(do { local $/; <$fh> });
		close $fh;
		$json->encode(render($req));
	};
	return $out if defined $out;
	my $err = $@ || 'Unknown error';
	return $json->encode({ errors => "PG render failed: $err", body_text => '', answers => {} });
}

1;
