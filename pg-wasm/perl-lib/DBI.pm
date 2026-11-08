package DBI;
# WebPerl stand-in for DBI (only used by PG's image-mode equation cache).
use strict; use warnings;
our $VERSION = '0.01_webperl';
sub connect { die "DBI is not available in WebPerl\n" }
1;
