#!/usr/bin/env node
// Converts a YAML file to JSON (used at build time for PG's configuration,
// which the YAML::XS stand-in in perl-lib reads as JSON).
const fs = require('fs');
const yaml = require('js-yaml');
const [, , input, output] = process.argv;
if (!input || !output) {
	console.error('Usage: yaml2json.js INPUT.yml OUTPUT.json');
	process.exit(1);
}
fs.writeFileSync(output, JSON.stringify(yaml.load(fs.readFileSync(input, 'utf8'))));
