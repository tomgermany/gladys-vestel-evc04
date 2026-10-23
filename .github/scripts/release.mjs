// -----------------------------------------------------------------------------
// Hebt die Version an: in package.json UND im Manifest, dazu den Changelog.
//
// WARUM EIN SKRIPT UND NICHT DREI HANDGRIFFE
// Das Manifest nennt das Image, das Gladys zieht, und package.json traegt dieselbe
// Version. Die beiden auseinanderlaufen zu lassen ist kein sichtbarer Fehler — es
// ist die alte Version, die weiter ausgeliefert wird. Ein Skript, das beide
// zusammen schreibt, nimmt genau diese Fehlerklasse raus.
//
// Aufruf:  node .github/scripts/release.mjs patch|minor|major
// Ausgabe: version=<neu>  nach $GITHUB_OUTPUT, und die neue CHANGELOG.md
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const bump = process.argv[2];
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error('Aufruf: node .github/scripts/release.mjs patch|minor|major');
  process.exit(1);
}

const nextVersion = (version, part) => {
  const [major, minor, patch] = version.split('.').map(Number);
  if (part === 'major') return `${major + 1}.0.0`;
  if (part === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
};

// --- package.json -----------------------------------------------------------
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = nextVersion(pkg.version, bump);
pkg.version = version;
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

// --- Manifest: die Version UND der Tag im Image ------------------------------
// Beide gehoeren zusammen: ein Manifest, das die neue Version nennt, aber noch
// auf das alte Image zeigt, ist genau der halbe Zustand, den es zu vermeiden gilt.
const manifestPath = 'gladys-assistant-integration.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.version = version;
manifest.docker_image = manifest.docker_image.replace(/:([^:/]+)$/, `:${version}`);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// --- CHANGELOG ---------------------------------------------------------------
// Die `## [Unreleased]`-Sektion wird zur neuen Version. Gibt es keine, wird eine
// schlichte Sektion angelegt: eine Version ohne Changelog-Zeile ist besser als ein
// Skript, das den Lauf abbricht.
const changelogPath = 'CHANGELOG.md';
const today = new Date().toISOString().slice(0, 10);
let changelog = existsSync(changelogPath)
  ? readFileSync(changelogPath, 'utf8')
  : '# Changelog\n\n## [Unreleased]\n';

if (changelog.includes('## [Unreleased]')) {
  changelog = changelog.replace('## [Unreleased]', `## [${version}] - ${today}`);
} else {
  changelog = changelog.replace(/^(# .*\n)/, `$1\n## [${version}] - ${today}\n`);
}
writeFileSync(changelogPath, changelog);

// --- Ausgabe fuers Workflow --------------------------------------------------
const out = process.env.GITHUB_OUTPUT;
if (out) writeFileSync(out, `version=${version}\n`, { flag: 'a' });
console.log(`Version: ${version}`);
console.log(`Image:   ${manifest.docker_image}`);
