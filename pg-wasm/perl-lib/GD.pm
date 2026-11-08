package GD;

# Stand-in for the GD module (libgd) in the WebAssembly build of PG.
#
# libgd is not available in the browser. This module lets PG's legacy graphing
# modules (WWPlot, Fun, Label, Circle, VectorField) load. Creating a GD image
# dies with a clear message. Problems that use the modern Plots macros
# (JSXGraph/TikZ output) are not affected.

use strict;
use warnings;

our $VERSION = '0.01_wasm';
our @ISA;

# Constants that PG refers to at compile time
use constant {
	gdBrushed     => -3,
	gdStyled      => -2,
	gdTransparent => -6,
	gdMaxColors   => 256,
};

my $unavailable = "GD graphics (WWPlot/init_graph) are not available in the browser build of PG\n";

sub import { }

# Fonts
for my $font (qw(gdTinyFont gdSmallFont gdMediumBoldFont gdLargeFont gdGiantFont)) {
	no strict 'refs';
	*{"GD::$font"} = sub { bless { name => $font }, 'GD::Font' };
	*{"GD::Font::$font"} = *{"GD::$font"};
}

package GD::Font;
sub width  {8}
sub height {16}
sub Tiny       { GD::gdTinyFont() }
sub Small      { GD::gdSmallFont() }
sub MediumBold { GD::gdMediumBoldFont() }
sub Large      { GD::gdLargeFont() }
sub Giant      { GD::gdGiantFont() }

package GD::Image;
sub new          { die $unavailable }
sub newTrueColor { die $unavailable }
sub newFromPng   { die $unavailable }
sub newFromGif   { die $unavailable }
sub newFromJpeg  { die $unavailable }
sub stringFT     { die $unavailable }
sub stringTTF    { die $unavailable }
sub _make_filehandle { die $unavailable }
sub _image_type      { die $unavailable }

package GD::Polygon;
sub new { die $unavailable }

1;
