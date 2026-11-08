package YAML::XS;
# WebPerl stand-in for YAML::XS: loads a JSON copy of the YAML file that was
# generated at build time ("file.yml" -> "file.yml.json").
use strict; use warnings;
use JSON::PP ();
use Exporter 'import';
our @EXPORT_OK = qw(LoadFile Load);
our $VERSION = '0.01_webperl';
sub LoadFile {
	my ($file) = @_;
	my $json = "$file.json";
	open my $fh, '<:raw', $json or die "YAML::XS stand-in: cannot read $json (was it generated at build time?): $!";
	local $/; my $data = <$fh>;
	return JSON::PP->new->utf8->decode($data);
}
sub Load { die "YAML::XS::Load is not supported in WebPerl" }
1;
