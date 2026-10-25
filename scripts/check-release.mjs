// Release guard: the tag must be v + package.json version, and CHANGELOG.md
// must have a section for that version. Also extracts that section for the
// GitHub release notes.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function headingPattern(version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^## \\[${escaped}\\](?: - .*)?[ \\t]*$`, "m");
}

/** The body of the `## [version]` section, trimmed, or null if absent. */
export function changelogSection(changelog, version) {
  const text = changelog.replace(/\r\n/g, "\n");
  const match = headingPattern(version).exec(text);
  if (!match) return null;
  const rest = text.slice(match.index + match[0].length);
  const next = rest.search(/^## /m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/** An error message, or null when the tag may be released. */
export function checkRelease(tag, pkgVersion, changelog) {
  if (tag !== `v${pkgVersion}`) {
    return `Tag "${tag}" does not match package.json version ${pkgVersion} (expected "v${pkgVersion}").`;
  }
  if (changelogSection(changelog, pkgVersion) === null) {
    return `CHANGELOG.md has no "## [${pkgVersion}]" section.`;
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const notesIndex = args.indexOf("--notes");
  const notesFile = notesIndex === -1 ? null : args[notesIndex + 1];
  const tag = args.find((arg, i) => arg !== "--notes" && (notesIndex === -1 || i !== notesIndex + 1));
  if (!tag || (notesIndex !== -1 && !notesFile)) {
    console.error("Usage: node scripts/check-release.mjs <tag> [--notes <file>]");
    process.exit(1);
  }
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  const error = checkRelease(tag, pkg.version, changelog);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  if (notesFile) writeFileSync(notesFile, `${changelogSection(changelog, pkg.version)}\n`);
}
