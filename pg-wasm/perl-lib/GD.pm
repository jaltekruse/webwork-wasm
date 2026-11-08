package GD;

# A pure-Perl implementation of the parts of the GD graphics library (libgd and
# the GD CPAN module) that PG uses, for the WebAssembly build of PG, where the
# C library isn't available.
#
# It covers what PG's legacy graphing modules (WWPlot, Fun, Label, Circle,
# VectorField) and problems in the Open Problem Library use: palette images,
# lines (with thickness, dashed, styled and brushed), rectangles, polygons,
# arcs and ellipses, flood fills, GD's built-in bitmap fonts, copying, and PNG
# output. Drawing follows libgd's conventions (integer pixel coordinates, the
# first allocated color is the background, angles in degrees clockwise from
# 3 o'clock). Anti-aliasing, TrueType text and reading image files are not
# supported.

use strict;
use warnings;

use Compress::Raw::Zlib ();
use GD::Fonts;

our $VERSION = '2.83';    # WWPlot checks this to decide between PNG and GIF output.
our @ISA;

use constant {
	gdAntiAliased   => -7,
	gdBrushed       => -3,
	gdStyled        => -2,
	gdStyledBrushed => -4,
	gdTiled         => -5,
	gdTransparent   => -6,
	gdMaxColors     => 256,
	gdArc           => 0,
	gdPie           => 0,
	gdChord         => 1,
	gdNoFill        => 2,
	gdEdged         => 4,
	gdDashSize      => 4,
};

our @EXPORT = qw(gdBrushed gdStyled gdStyledBrushed gdTiled gdTransparent gdAntiAliased gdMaxColors
	gdArc gdPie gdChord gdNoFill gdEdged gdTinyFont gdSmallFont gdMediumBoldFont gdLargeFont gdGiantFont);

sub import {
	my $caller = caller;
	no strict 'refs';
	*{"${caller}::$_"} = \&{"GD::$_"} for @EXPORT;
	return;
}

my %font_cache;
sub _font { my $name = shift; return $font_cache{$name} //= GD::Font->_load($name) }
sub gdTinyFont       { _font('Tiny') }
sub gdSmallFont      { _font('Small') }
sub gdMediumBoldFont { _font('MediumBold') }
sub gdLargeFont      { _font('Large') }
sub gdGiantFont      { _font('Giant') }

package GD::Font;

sub _load {
	my ($class, $name) = @_;
	my $f = $GD::Fonts::FONTS{$name} or die "Unknown GD font $name\n";
	my ($nchars, $offset, $w, $h, $hex) = @$f;
	return bless { name => $name, nchars => $nchars, offset => $offset, w => $w, h => $h,
		bits => unpack('B*', pack('H*', $hex)) }, $class;
}
sub Tiny       { GD::gdTinyFont() }
sub Small      { GD::gdSmallFont() }
sub MediumBold { GD::gdMediumBoldFont() }
sub Large      { GD::gdLargeFont() }
sub Giant      { GD::gdGiantFont() }
sub width      { $_[0]{w} }
sub height     { $_[0]{h} }
sub nchars     { $_[0]{nchars} }
sub offset     { $_[0]{offset} }

# Returns the glyph rows of a character, as strings of 0/1.
sub _glyph {
	my ($self, $char) = @_;
	my $c = ord($char) - $self->{offset};
	return if $c < 0 || $c >= $self->{nchars};
	my $size = $self->{w} * $self->{h};
	my $bits = substr($self->{bits}, $c * $size, $size);
	return map { substr($bits, $_ * $self->{w}, $self->{w}) } 0 .. $self->{h} - 1;
}

package GD::Image;

use POSIX ();

my $unsupported = sub { die "GD::Image::$_[0] is not supported in the browser build of PG\n" };

sub new {
	my ($class, @args) = @_;
	$class = ref $class || $class;
	# Reading images from files or data is not supported.
	die "GD::Image->new: reading image files is not supported in the browser build of PG\n"
		if @args && (!defined $args[0] || $args[0] !~ /^\s*\d+(\.\d*)?\s*$/);
	my ($w, $h, $truecolor) = @args;
	$w = int($w // 64);
	$h = int($h // 64);
	$w = 1 if $w < 1;
	$h = 1 if $h < 1;
	my $self = bless {
		w           => $w,
		h           => $h,
		px          => "\0" x ($w * $h),
		colors      => [],
		transparent => -1,
		thickness   => 1,
		style       => [],
		style_pos   => 0,
		brush       => undef,
		interlaced  => 0,
		truecolor   => $truecolor ? 1 : 0,
	}, $class;
	# A true color image starts out black, a palette image with the first allocated color.
	$self->colorAllocate(0, 0, 0) if $truecolor;
	return $self;
}

sub newTrueColor { my ($class, $w, $h) = @_; return $class->new($w, $h, 1) }

for my $m (qw(newFromPng newFromPngData newFromGif newFromGifData newFromJpeg newFromJpegData newFromGd
	newFromGd2 newFromGd2Part newFromXbm newFromXpm newFromWBMP newFromBmp newFromWebp newFromTiff
	newFromHeif jpeg webp tiff bmp wbmp gd gd2 stringFT stringTTF stringFTCircle))
{
	no strict 'refs';
	*{"GD::Image::$m"} = sub { $unsupported->($m) };
}

sub width       { $_[0]{w} }
sub height      { $_[0]{h} }
sub getBounds   { ($_[0]{w}, $_[0]{h}) }
sub isTrueColor { $_[0]{truecolor} }
sub interlaced  { my $self = shift; $self->{interlaced} = shift if @_; return $self->{interlaced} }
sub trueColor               { return }
sub alphaBlending           { return }
sub saveAlpha               { return }
sub clip                    { return }
sub setAntiAliased          { return }
sub setAntiAliasedDontBlend { return }
sub setTile                 { return }

# ##### Colors #####

sub colorAllocate { my ($self, $r, $g, $b) = @_; return $self->colorAllocateAlpha($r, $g, $b, 0) }

sub colorAllocateAlpha {
	my ($self, $r, $g, $b, $a) = @_;
	return -1 if @{ $self->{colors} } >= 256;
	push @{ $self->{colors} }, [ (map { my $v = int($_ // 0); $v < 0 ? 0 : $v > 255 ? 255 : $v } $r, $g, $b), int($a // 0) ];
	return $#{ $self->{colors} };
}

sub colorExact {
	my ($self, $r, $g, $b) = @_;
	my $c = $self->{colors};
	for my $i (0 .. $#$c) { return $i if $c->[$i][0] == $r && $c->[$i][1] == $g && $c->[$i][2] == $b }
	return -1;
}

sub colorClosest {
	my ($self, $r, $g, $b) = @_;
	my ($best, $dist) = (-1, undef);
	my $c = $self->{colors};
	for my $i (0 .. $#$c) {
		my $d = ($c->[$i][0] - $r)**2 + ($c->[$i][1] - $g)**2 + ($c->[$i][2] - $b)**2;
		($best, $dist) = ($i, $d) if !defined $dist || $d < $dist;
	}
	return $best;
}

sub colorResolve {
	my ($self, $r, $g, $b) = @_;
	my $i = $self->colorExact($r, $g, $b);
	$i = $self->colorAllocate($r, $g, $b) if $i < 0;
	$i = $self->colorClosest($r, $g, $b) if $i < 0;
	return $i;
}
sub colorClosestHWB { my $s = shift; return $s->colorClosest(@_) }
sub colorDeallocate { return }
sub colorsTotal     { scalar @{ $_[0]{colors} } }
sub rgb             { my ($self, $i) = @_; my $c = $self->{colors}[$i] or return; return @$c[ 0 .. 2 ] }
sub alpha           { my ($self, $i) = @_; my $c = $self->{colors}[$i] or return; return $c->[3] }

sub transparent {
	my $self = shift;
	$self->{transparent} = int(shift) if @_;
	return $self->{transparent};
}

# ##### Pixels #####

sub _put {
	my ($self, $x, $y, $c) = @_;
	return if $x < 0 || $y < 0 || $x >= $self->{w} || $y >= $self->{h} || $c < 0 || $c > 255;
	substr($self->{px}, $y * $self->{w} + $x, 1, chr($c));
	return;
}

sub getPixel {
	my ($self, $x, $y) = @_;
	($x, $y) = (int($x), int($y));
	return 0 if $x < 0 || $y < 0 || $x >= $self->{w} || $y >= $self->{h};
	return ord(substr($self->{px}, $y * $self->{w} + $x, 1));
}

# Plots one pixel with a color that may be special (styled, brushed).
sub _plot {
	my ($self, $x, $y, $c) = @_;
	if ($c >= 0) { $self->_put($x, $y, $c) }
	elsif ($c == GD::gdStyled) {
		my $style = $self->{style};
		return unless @$style;
		my $sc = $style->[ $self->{style_pos}++ % @$style ];
		$self->_put($x, $y, $sc) if defined $sc && $sc >= 0;
	} elsif ($c == GD::gdBrushed) {
		$self->_stamp_brush($x, $y);
	} elsif ($c == GD::gdStyledBrushed) {
		my $style = $self->{style};
		return unless @$style;
		my $on = $style->[ $self->{style_pos}++ % @$style ];
		$self->_stamp_brush($x, $y) if $on && $on != GD::gdTransparent;
	}
	return;
}

sub setPixel {
	my ($self, $x, $y, $c) = @_;
	$self->_plot(int($x), int($y), int($c));
	return;
}

sub _stamp_brush {
	my ($self, $x, $y) = @_;
	my $b = $self->{brush} or return;
	my ($bw, $bh) = ($b->{w}, $b->{h});
	my ($x0, $y0) = ($x - int($bw / 2), $y - int($bh / 2));
	my $map = $self->{brush_map} //= [ map { $self->colorResolve(@{ $b->{colors}[$_] }[ 0 .. 2 ]) } 0 .. $#{ $b->{colors} } ];
	for my $j (0 .. $bh - 1) {
		for my $i (0 .. $bw - 1) {
			my $bc = ord(substr($b->{px}, $j * $bw + $i, 1));
			next if $bc == $b->{transparent};
			$self->_put($x0 + $i, $y0 + $j, $map->[$bc] // 0);
		}
	}
	return;
}

sub setBrush { my ($self, $brush) = @_; $self->{brush} = $brush; delete $self->{brush_map}; return }

sub setStyle {
	my ($self, @colors) = @_;
	$self->{style}     = [ map { int $_ } @colors ];
	$self->{style_pos} = 0;
	return;
}

sub setThickness { my ($self, $t) = @_; $self->{thickness} = int($t // 1) || 1; return }

# ##### Lines #####

# Calls $cb->($x, $y) for each point of the line (Bresenham).
sub _line_points {
	my ($x1, $y1, $x2, $y2, $cb) = @_;
	my ($dx, $dy) = (abs($x2 - $x1), -abs($y2 - $y1));
	my ($sx, $sy) = ($x1 < $x2 ? 1 : -1, $y1 < $y2 ? 1 : -1);
	my $err = $dx + $dy;
	while (1) {
		$cb->($x1, $y1);
		last if $x1 == $x2 && $y1 == $y2;
		my $e2 = 2 * $err;
		if ($e2 >= $dy) { $err += $dy; $x1 += $sx }
		if ($e2 <= $dx) { $err += $dx; $y1 += $sy }
	}
	return;
}

# Draws a line; with thickness > 1, a run of pixels perpendicular to the main
# direction is plotted at each point (like libgd).
sub _thick_line {
	my ($self, $x1, $y1, $x2, $y2, $c, $on) = @_;
	# libgd applies the thickness to styled lines too (a brush has its own size)
	my $t          = ($c == GD::gdBrushed || $c == GD::gdStyledBrushed) ? 1 : $self->{thickness};
	my $horizontal = abs($x2 - $x1) >= abs($y2 - $y1);
	my $lo         = -int(($t - 1) / 2);
	my $hi         = $lo + $t - 1;
	my $n          = 0;
	_line_points($x1, $y1, $x2, $y2, sub {
		my ($x, $y) = @_;
		return if $on && !$on->($n++);
		if ($t == 1) { $self->_plot($x, $y, $c); return }
		for my $o ($lo .. $hi) { $horizontal ? $self->_plot($x, $y + $o, $c) : $self->_plot($x + $o, $y, $c) }
	});
	return;
}

sub line {
	my ($self, @a) = @_;
	$self->_thick_line(map { int($_ // 0) } @a[ 0 .. 4 ]);
	return;
}

sub dashedLine {
	my ($self, @a) = @_;
	$self->_thick_line((map { int($_ // 0) } @a[ 0 .. 4 ]), sub { ($_[0] % (2 * GD::gdDashSize)) < GD::gdDashSize });
	return;
}

# ##### Shapes #####

sub rectangle {
	my ($self, $x1, $y1, $x2, $y2, $c) = @_;
	$self->line($x1, $y1, $x2, $y1, $c);
	$self->line($x2, $y1, $x2, $y2, $c);
	$self->line($x2, $y2, $x1, $y2, $c);
	$self->line($x1, $y2, $x1, $y1, $c);
	return;
}

sub filledRectangle {
	my ($self, $x1, $y1, $x2, $y2, $c) = @_;
	($x1, $y1, $x2, $y2, $c) = map { int($_ // 0) } $x1, $y1, $x2, $y2, $c;
	($x1, $x2) = ($x2, $x1) if $x1 > $x2;
	($y1, $y2) = ($y2, $y1) if $y1 > $y2;
	if ($c < 0) {
		for my $y ($y1 .. $y2) { $self->_plot($_, $y, $c) for $x1 .. $x2 }
		return;
	}
	$x1 = 0 if $x1 < 0;
	$x2 = $self->{w} - 1 if $x2 >= $self->{w};
	$y1 = 0 if $y1 < 0;
	$y2 = $self->{h} - 1 if $y2 >= $self->{h};
	return if $x1 > $x2 || $y1 > $y2 || $c > 255;
	my $run = chr($c) x ($x2 - $x1 + 1);
	substr($self->{px}, $_ * $self->{w} + $x1, length $run, $run) for $y1 .. $y2;
	return;
}

sub _points { my $poly = shift; return ref $poly eq 'ARRAY' ? @$poly : $poly->vertices }

sub polygon {
	my ($self, $poly, $c) = @_;
	my @p = _points($poly);
	return unless @p;
	return $self->setPixel(@{ $p[0] }, $c) if @p == 1;
	$self->line(@{ $p[ $_ - 1 ] }, @{ $p[$_] }, $c) for 1 .. $#p;
	$self->line(@{ $p[-1] }, @{ $p[0] }, $c);
	return;
}

sub openPolygon {
	my ($self, $poly, $c) = @_;
	my @p = _points($poly);
	return unless @p;
	return $self->setPixel(@{ $p[0] }, $c) if @p == 1;
	$self->line(@{ $p[ $_ - 1 ] }, @{ $p[$_] }, $c) for 1 .. $#p;
	return;
}
sub unclosedPolygon { my $s = shift; return $s->openPolygon(@_) }

# Scanline polygon fill (even-odd rule), including the polygon's edges.
sub filledPolygon {
	my ($self, $poly, $c) = @_;
	my @p = map { [ int($_->[0]), int($_->[1]) ] } _points($poly);
	return unless @p;
	$c = int $c;
	my ($ymin, $ymax) = ($p[0][1], $p[0][1]);
	for (@p) { $ymin = $_->[1] if $_->[1] < $ymin; $ymax = $_->[1] if $_->[1] > $ymax }
	$ymin = 0 if $ymin < 0;
	$ymax = $self->{h} - 1 if $ymax >= $self->{h};
	for my $y ($ymin .. $ymax) {
		my @xs;
		for my $i (0 .. $#p) {
			my ($a, $b) = ($p[ $i - 1 ], $p[$i]);
			next if $a->[1] == $b->[1];
			($a, $b) = ($b, $a) if $a->[1] > $b->[1];
			# half-open at the bottom end, so shared vertices are counted once
			next unless $y >= $a->[1] && $y < $b->[1];
			push @xs, $a->[0] + ($y - $a->[1]) * ($b->[0] - $a->[0]) / ($b->[1] - $a->[1]);
		}
		@xs = sort { $a <=> $b } @xs;
		while (@xs >= 2) {
			my ($xa, $xb) = splice(@xs, 0, 2);
			$self->filledRectangle(POSIX::ceil($xa - 0.5), $y, POSIX::floor($xb + 0.5), $y, $c);
		}
	}
	# Edges (this also covers the bottom row and horizontal edges)
	my $t = $self->{thickness};
	$self->{thickness} = 1;
	$self->polygon(\@p, $c);
	$self->{thickness} = $t;
	return;
}

# Points of an elliptical arc (angles in degrees, clockwise from 3 o'clock),
# in 1 degree steps like libgd.
sub _arc_points {
	my ($cx, $cy, $w, $h, $s, $e) = @_;
	$s %= 360 if $s > 360 || $s < 0;
	$e %= 360 if $e > 360 || $e < 0;
	$e += 360 while $e < $s;
	$e = $s + 360 if $e == $s;
	my $deg = 4 * atan2(1, 1) / 180;
	return map { [ int($cx + cos($_ * $deg) * $w / 2), int($cy + sin($_ * $deg) * $h / 2) ] } $s .. $e;
}

sub arc {
	my ($self, $cx, $cy, $w, $h, $s, $e, $c) = @_;
	my @p = _arc_points($cx, $cy, $w, $h, int $s, int $e);
	$self->line(@{ $p[ $_ - 1 ] }, @{ $p[$_] }, $c) for 1 .. $#p;
	return;
}

sub filledArc {
	my ($self, $cx, $cy, $w, $h, $s, $e, $c, $style) = @_;
	$style //= 0;
	my @p = _arc_points($cx, $cy, $w, $h, int $s, int $e);
	my @center = (int $cx, int $cy);
	if ($style & GD::gdNoFill) {
		if ($style & GD::gdChord) { $self->line(@{ $p[0] }, @{ $p[-1] }, $c) }
		else                      { $self->line(@{ $p[ $_ - 1 ] }, @{ $p[$_] }, $c) for 1 .. $#p }
		if ($style & GD::gdEdged) {
			$self->line(@center, @{ $p[0] },  $c);
			$self->line(@center, @{ $p[-1] }, $c);
		}
	} elsif ($style & GD::gdChord) {
		$self->filledPolygon([ $p[0], $p[-1], \@center ], $c);
	} else {
		$self->filledPolygon([ \@center, @p ], $c);
	}
	return;
}

sub ellipse { my ($self, $cx, $cy, $w, $h, $c) = @_; return $self->arc($cx, $cy, $w, $h, 0, 360, $c) }

sub filledEllipse {
	my ($self, $cx, $cy, $w, $h, $c) = @_;
	return $self->filledPolygon([ _arc_points($cx, $cy, $w, $h, 0, 360) ], $c);
}

# ##### Fills #####

# Span flood fill: fills the 4-connected region of pixels for which
# $inside->(color) is true, starting at (x, y). $inside must be false for the
# fill color, so filled pixels aren't visited again.
sub _flood {
	my ($self, $x, $y, $c, $inside) = @_;
	my ($w, $h) = ($self->{w}, $self->{h});
	return if $x < 0 || $y < 0 || $x >= $w || $y >= $h || $c < 0 || $c > 255;
	my $fill  = chr($c);
	my @stack = ([ $x, $y ]);
	while (my $seed = pop @stack) {
		my ($sx, $sy) = @$seed;
		my $row = $sy * $w;
		next unless $inside->(ord(substr($self->{px}, $row + $sx, 1)));
		my ($l, $r) = ($sx, $sx);
		$l-- while $l > 0 && $inside->(ord(substr($self->{px}, $row + $l - 1, 1)));
		$r++ while $r < $w - 1 && $inside->(ord(substr($self->{px}, $row + $r + 1, 1)));
		substr($self->{px}, $row + $l, $r - $l + 1, $fill x ($r - $l + 1));
		for my $ny ($sy - 1, $sy + 1) {
			next if $ny < 0 || $ny >= $h;
			my $nrow = $ny * $w;
			my $in   = 0;
			for my $nx ($l .. $r) {
				if ($inside->(ord(substr($self->{px}, $nrow + $nx, 1)))) {
					push @stack, [ $nx, $ny ] unless $in;
					$in = 1;
				} else {
					$in = 0;
				}
			}
		}
	}
	return;
}

sub fill {
	my ($self, $x, $y, $c) = @_;
	($x, $y, $c) = (int $x, int $y, int $c);
	my $old = $self->getPixel($x, $y);
	return if $old == $c;
	$self->_flood($x, $y, $c, sub { $_[0] == $old });
	return;
}

sub fillToBorder {
	my ($self, $x, $y, $border, $c) = @_;
	($x, $y, $border, $c) = (int $x, int $y, int $border, int $c);
	return if $border < 0 || $c < 0;
	$self->_flood($x, $y, $c, sub { $_[0] != $border && $_[0] != $c });
	return;
}

# ##### Text #####

sub _string {
	my ($self, $font, $x, $y, $s, $c, $up) = @_;
	($x, $y, $c) = (int $x, int $y, int $c);
	$font = GD::gdSmallFont() unless ref $font;
	for my $ch (split //, $s // '') {
		my @rows = $font->_glyph($ch);
		for my $j (0 .. $#rows) {
			my $row = $rows[$j];
			for my $i (0 .. length($row) - 1) {
				next unless substr($row, $i, 1);
				$up ? $self->_plot($x + $j, $y - $i, $c) : $self->_plot($x + $i, $y + $j, $c);
			}
		}
		$up ? ($y -= $font->{w}) : ($x += $font->{w});
	}
	return;
}

sub string   { my ($self, $font, $x, $y, $s, $c) = @_; return $self->_string($font, $x, $y, $s, $c, 0) }
sub stringUp { my ($self, $font, $x, $y, $s, $c) = @_; return $self->_string($font, $x, $y, $s, $c, 1) }
sub char     { my ($self, $font, $x, $y, $s, $c) = @_; return $self->_string($font, $x, $y, substr($s // '', 0, 1), $c, 0) }
sub charUp   { my ($self, $font, $x, $y, $s, $c) = @_; return $self->_string($font, $x, $y, substr($s // '', 0, 1), $c, 1) }

# ##### Copying #####

sub copy {
	my ($dst, $src, $dx, $dy, $sx, $sy, $w, $h) = @_;
	return $dst->copyResized($src, $dx, $dy, $sx, $sy, $w, $h, $w, $h);
}

sub copyResized {
	my ($dst, $src, $dx, $dy, $sx, $sy, $dw, $dh, $sw, $sh) = @_;
	($dx, $dy, $sx, $sy, $dw, $dh, $sw, $sh) = map { int($_ // 0) } $dx, $dy, $sx, $sy, $dw, $dh, $sw, $sh;
	return if $dw <= 0 || $dh <= 0 || $sw <= 0 || $sh <= 0;
	my %map;
	for my $j (0 .. $dh - 1) {
		my $syy = $sy + int($j * $sh / $dh);
		for my $i (0 .. $dw - 1) {
			my $sxx = $sx + int($i * $sw / $dw);
			next if $sxx < 0 || $syy < 0 || $sxx >= $src->{w} || $syy >= $src->{h};
			my $sc = ord(substr($src->{px}, $syy * $src->{w} + $sxx, 1));
			next if $sc == $src->{transparent};
			my $dc = $map{$sc} //= do {
				my $rgb = $src->{colors}[$sc] // [ 0, 0, 0 ];
				$dst->colorResolve(@$rgb[ 0 .. 2 ]);
			};
			$dst->_put($dx + $i, $dy + $j, $dc);
		}
	}
	return;
}
sub copyResampled { my $s = shift; return $s->copyResized(@_) }
sub copyMerge     { my ($s, @a) = @_; return $s->copy(@a[ 0 .. 6 ]) }

sub clone {
	my $self = shift;
	my %copy = %$self;
	$copy{colors} = [ map { [@$_] } @{ $self->{colors} } ];
	$copy{style}  = [ @{ $self->{style} } ];
	return bless \%copy, ref $self;
}

# ##### Output #####

sub _chunk {
	my ($type, $data) = @_;
	return pack('N', length $data) . $type . $data . pack('N', Compress::Raw::Zlib::crc32($type . $data));
}

# A zlib stream with the data in "stored" (uncompressed) deflate blocks. PG
# runs problem code in a Safe compartment, where zlib's compression objects
# can't be used (their classes aren't visible there), but its plain checksum
# functions can. GD::recompress_png (called outside of the compartment)
# compresses the result later.
sub _zlib_stored {
	my ($data) = @_;
	my $out = "\x78\x01";
	my $len = length $data;
	my $pos = 0;
	do {
		my $n = $len - $pos > 65535 ? 65535 : $len - $pos;
		$out .= pack('Cvv', $pos + $n >= $len ? 1 : 0, $n, ~$n & 0xffff) . substr($data, $pos, $n);
		$pos += $n;
	} while ($pos < $len);
	return $out . pack('N', Compress::Raw::Zlib::adler32($data));
}

sub png {
	my ($self, $level) = @_;
	my ($w, $h) = ($self->{w}, $self->{h});
	my @colors = @{ $self->{colors} };
	@colors = ([ 255, 255, 255, 0 ]) unless @colors;
	my $raw = join '', map { "\0" . substr($self->{px}, $_ * $w, $w) } 0 .. $h - 1;
	my $png = "\x89PNG\r\n\x1a\n";
	$png .= _chunk('IHDR', pack('NNCCCCC', $w, $h, 8, 3, 0, 0, 0));
	$png .= _chunk('PLTE', join '', map { pack('CCC', @$_[ 0 .. 2 ]) } @colors);
	my @alpha = map { $_ == $self->{transparent} ? 0 : 255 - int(($colors[$_][3] // 0) * 255 / 127) } 0 .. $#colors;
	pop @alpha while @alpha && $alpha[-1] == 255;
	$png .= _chunk('tRNS', pack('C*', @alpha)) if @alpha;
	$png .= _chunk('IDAT', _zlib_stored($raw));
	$png .= _chunk('IEND', '');
	return $png;
}

# GIF output isn't implemented; PNG data is returned instead (browsers detect
# the format from the data). WWPlot uses PNG anyway because of $GD::VERSION.
sub gif { my $self = shift; return $self->png }

# Recompresses the image data of a PNG file written by GD::Image::png (which
# stores it uncompressed, see above). Must be called outside of PG's Safe
# compartment. Returns the PNG data unchanged if it isn't such a file.
sub GD::recompress_png {
	my ($png) = @_;
	return $png unless substr($png, 0, 8) eq "\x89PNG\r\n\x1a\n";
	require Compress::Zlib;
	my ($pos, $out, $idat) = (8, substr($png, 0, 8), '');
	while ($pos + 8 <= length $png) {
		my ($len, $type) = unpack('Na4', substr($png, $pos, 8));
		my $data = substr($png, $pos + 8, $len);
		$pos += 12 + $len;
		if ($type eq 'IDAT') { $idat .= $data; next }
		if ($type eq 'IEND' && length $idat) {
			my $raw = Compress::Zlib::uncompress($idat) // return $png;
			$out .= GD::Image::_chunk('IDAT', Compress::Zlib::compress($raw, 9));
		}
		$out .= GD::Image::_chunk($type, $data);
	}
	return $out;
}

package GD::Polygon;

sub new      { my $class = shift; return bless { pts => [] }, ref $class || $class }
sub addPt    { my ($self, $x, $y) = @_; push @{ $self->{pts} }, [ $x, $y ]; return }
sub getPt    { my ($self, $i) = @_; my $p = $self->{pts}[$i] or return; return @$p }
sub setPt    { my ($self, $i, $x, $y) = @_; $self->{pts}[$i] = [ $x, $y ]; return }
sub deletePt { my ($self, $i) = @_; my ($p) = splice(@{ $self->{pts} }, $i, 1); return $p ? @$p : () }
sub length   { scalar @{ $_[0]{pts} } }
sub vertices { map { [@$_] } @{ $_[0]{pts} } }
sub clear    { $_[0]{pts} = []; return }

sub bounds {
	my $self = shift;
	my @p = @{ $self->{pts} } or return (0, 0, 0, 0);
	my ($l, $t, $r, $b) = (@{ $p[0] }, @{ $p[0] });
	for (@p) {
		$l = $_->[0] if $_->[0] < $l;
		$r = $_->[0] if $_->[0] > $r;
		$t = $_->[1] if $_->[1] < $t;
		$b = $_->[1] if $_->[1] > $b;
	}
	return ($l, $t, $r, $b);
}

sub offset {
	my ($self, $dx, $dy) = @_;
	$_ = [ $_->[0] + $dx, $_->[1] + $dy ] for @{ $self->{pts} };
	return;
}

sub map {
	my ($self, $sl, $st, $sr, $sb, $dl, $dt, $dr, $db) = @_;
	my $xs = ($sr - $sl) ? ($dr - $dl) / ($sr - $sl) : 1;
	my $ys = ($sb - $st) ? ($db - $dt) / ($sb - $st) : 1;
	$_ = [ $dl + ($_->[0] - $sl) * $xs, $dt + ($_->[1] - $st) * $ys ] for @{ $self->{pts} };
	return;
}

sub scale {
	my ($self, $sx, $sy) = @_;
	$sy //= $sx;
	$_ = [ $_->[0] * $sx, $_->[1] * $sy ] for @{ $self->{pts} };
	return;
}

sub transform {
	my ($self, $sx, $rx, $ry, $sy, $tx, $ty) = @_;
	$_ = [ $_->[0] * $sx + $_->[1] * $ry + $tx, $_->[0] * $rx + $_->[1] * $sy + $ty ] for @{ $self->{pts} };
	return;
}

1;
