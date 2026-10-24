// -----------------------------------------------------------------------------
// Hebt die Version an: in package.json UND im Manifest, dazu den Changelog —
// und legt die Notizen fuer den GitHub-Release ab.
//
// WARUM EIN SKRIPT UND NICHT DREI HANDGRIFFE
// Das Manifest nennt das Image, das Gladys zieht, und package.json traegt dieselbe
// Version. Die beiden auseinanderlaufen zu lassen ist kein sichtbarer Fehler — es
// ist die alte Version, die weiter ausgeliefert wird. Ein Skript, das beide
// zusammen schreibt, nimmt genau diese Fehlerklasse raus.
//
// WARUM DIE NOTIZEN HIER ENTSTEHEN UND NICHT MIT --generate-notes
// Die Release-Notizen sollen die Changelog-Sektion dieser Version sein, nicht eine
// von GitHub erfundene Liste zusammengefasster Commits. Dafuer wird die Sektion
// hier ausgelesen und in eine eigene Datei geschrieben; der Workflow verweist mit
// `--notes-file` darauf.
//
// WARUM DAS EIN EIGENER ABSCHNITT WAR
// Der Workflow verweist auf `steps.release.outputs.notes_file`. Diesen Ausgang gab
// es hier einmal nicht, und `--notes-file ""` brach `gh release create` ab — der Tag
// war schon gesetzt, der Release fehlte. Deshalb schreibt dieses Skript BEIDE
// Ausgaenge, die der Workflow nennt.
//
// Aufruf:  node .github/scripts/release.mjs patch|minor|major
// Ausgabe: version=<neu> und notes_file=<pfad> nach $GITHUB_OUTPUT
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

// --- Manifest: Version hochzaehlen, Image auf latest halten ------------------
// Die Manifest-Version wird weiterhin bei jedem Release erhoeht. Das Image bleibt
// auf latest, damit Gladys bei einem Update immer den neuesten Release zieht.
const manifestPath = 'gladys-assistant-integration.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.version = version;
manifest.docker_image = manifest.docker_image.replace(/:([^:/]+)$/, ':latest');
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// --- CHANGELOG ---------------------------------------------------------------
// Die `## [Unreleased]`-Sektion wird zur neuen Version. Gibt es keine, wird eine
// Sektion oben angelegt: eine Version ohne Changelog-Zeile ist besser als ein
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

// --- Die Notizen der neuen Version ------------------------------------------
// Alles, was unter `## [<version>]` steht, bis zur naechsten Sektion auf gleicher
// Ebene. Der Titel selbst kommt mit, damit die Notiz selbst sagt, worum es geht.
function sectionFor(text, wanted) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## [${wanted}]`));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => line.startsWith('## ['));
  const body = (next === -1 ? rest : rest.slice(0, next)).join('\n').trim();
  return `${lines[start].trim()}\n\n${body}\n`;
}

const notesPath = join(process.cwd(), 'RELEASE_NOTES.md');
const notes = sectionFor(changelog, version);
if (notes) {
  writeFileSync(notesPath, notes);
} else {
  // Ein Release ohne Notizen ist besser als ein Lauf, der hier abbricht: der Tag
  // und das Image sind zu diesem Zeitpunkt bereits wichtig genug.
  writeFileSync(notesPath, `## [${version}] - ${today}\n\nKeine Notizen eingetragen.\n`);
}

// --- Ausgabe fuers Workflow --------------------------------------------------
// BEIDE Ausgaenge, die release.yml nennt. Fehlt einer davon, wird daraus ein
// leerer Parameter, und der Schritt scheitert an einer Stelle, an der niemand
// einen Fehler vermutet.
const out = process.env.GITHUB_OUTPUT;
if (out) {
  writeFileSync(out, `version=${version}\n`, { flag: 'a' });
  writeFileSync(out, `notes_file=${notesPath}\n`, { flag: 'a' });
}

console.log(`Version:     ${version}`);
console.log(`Image:       ${manifest.docker_image}`);
console.log(`Notizen:     ${notesPath}`);
