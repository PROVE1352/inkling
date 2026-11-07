#!/usr/bin/perl
# Tiny JSON helper for the backup sidecar (the postgres:16 image ships perl + core JSON::PP,
# but no jq). Writes are atomic (tmp file + rename) because the app reads these files
# concurrently.
#
#   json.pl set FILE key=string key:=<json> a.b.c:=null ...   create/merge, dotted paths
#   json.pl get FILE a.b.c                                    print scalar (or JSON for objects)
#   json.pl keys FILE a.b                                     print object keys, one per line
#   json.pl obj key=string key:=<json> ...                    print a new JSON object
use strict;
use warnings;
use JSON::PP;

my $J = JSON::PP->new->utf8->canonical->pretty;

sub load {
  my ($f) = @_;
  return {} unless -s $f;
  open my $fh, '<', $f or die "open $f: $!";
  local $/;
  my $raw = <$fh>;
  close $fh;
  my $d = eval { decode_json($raw) };
  return ref $d eq 'HASH' ? $d : {};
}

sub save {
  my ($f, $d) = @_;
  my $tmp = "$f.tmp.$$";
  open my $fh, '>', $tmp or die "write $tmp: $!";
  print $fh $J->encode($d);
  close $fh or die "close $tmp: $!";
  rename $tmp, $f or die "rename $tmp: $!";
}

sub apply {
  my ($d, @pairs) = @_;
  for my $p (@pairs) {
    my ($k, $op, $v) = $p =~ /^([^:=]+)(:?=)(.*)$/s or die "bad pair: $p\n";
    my $val = $op eq ':=' ? JSON::PP->new->allow_nonref->decode($v) : $v;
    my @path = split /\./, $k;
    my $last = pop @path;
    my $node = $d;
    for my $seg (@path) {
      $node->{$seg} = {} unless ref $node->{$seg} eq 'HASH';
      $node = $node->{$seg};
    }
    $node->{$last} = $val;
  }
  return $d;
}

sub walk {
  my ($d, $k) = @_;
  my $node = $d;
  for my $seg (split /\./, $k) {
    return undef unless ref $node eq 'HASH' && exists $node->{$seg};
    $node = $node->{$seg};
  }
  return $node;
}

my $cmd = shift @ARGV // '';
if ($cmd eq 'set') {
  my $f = shift @ARGV;
  save($f, apply(load($f), @ARGV));
} elsif ($cmd eq 'obj') {
  print JSON::PP->new->utf8->canonical->encode(apply({}, @ARGV));
} elsif ($cmd eq 'get') {
  my ($f, $k) = @ARGV;
  my $v = walk(load($f), $k);
  exit 1 unless defined $v;
  if (ref $v) { print JSON::PP->new->utf8->canonical->encode($v), "\n" }
  elsif (JSON::PP::is_bool($v)) { print(($v ? 'true' : 'false'), "\n") }
  else { print "$v\n" }
} elsif ($cmd eq 'keys') {
  my ($f, $k) = @ARGV;
  my $v = walk(load($f), $k);
  exit 1 unless ref $v eq 'HASH';
  print "$_\n" for sort keys %$v;
} else {
  die "usage: json.pl set|get|keys|obj ...\n";
}
