# Releasing

A pushed tag `vX.Y.Z` runs `.github/workflows/release.yml`. It checks the tag
against `package.json` and `CHANGELOG.md`, runs typecheck, tests and the pack
check, publishes `@edorosh/shell-mcp` to npm and creates a GitHub release from
the changelog section. There is no npm token; npm trusts the workflow through
OIDC.

## One-time setup

npm cannot configure trusted publishing before the package exists, so 1.0.0 is
published by hand and CI publishes every later release.

1. Publish 1.0.0 by hand:
   - Make a fresh clone checked out at the `v1.0.0` tag (or run
     `git clean -xdf` in a clean checkout of it), so no stale gitignored
     `dist/` is packed.
   - Edit the `CHANGELOG.md` heading to `## [1.0.0] - YYYY-MM-DD` with the
     release date, if it has none yet.
   - `npm ci`
   - `npm test`
   - `node scripts/check-pack.mjs`
   - `npm login`
   - `npm publish`

   This version has no provenance. CI-published versions get it.
2. Push the `v1.0.0` tag. The workflow sees that 1.0.0 is already on npm,
   skips `npm publish` and creates the GitHub release. The same applies to
   a rerun of any half-failed release: the publish is skipped when the
   version already exists, so rerunning is safe.
3. Add the trusted publisher (GitHub Actions, repository `edorosh/shell-mcp`,
   workflow `release.yml`, no environment), either:
   - on npmjs.com: the package, Settings, Trusted publishing; or
   - from the command line (npm 11.15.0 or newer, 2FA on):
     `npm trust github @edorosh/shell-mcp --file release.yml --repo edorosh/shell-mcp --allow-publish`

   npm requires that "a newly created trusted publisher configuration must
   complete its first successful publish within 2 days"
   ([docs](https://docs.npmjs.com/trusted-publishers)). The v1.0.0 tag run
   publishes nothing, so the first CI publish is the next version: add the
   trusted publisher only when that release is ready, or within 2 days of it.

## Each release

1. `npm version <x.y.z> --no-git-tag-version`
2. Move the `## [Unreleased]` entries under a new `## [x.y.z] - YYYY-MM-DD`
   heading in `CHANGELOG.md`.
3. Open a PR and merge it.
4. On `main`: `git tag vX.Y.Z`, then `git push origin vX.Y.Z`.

If the guard fails, fix the version or changelog, delete the tag and tag again.

## SDK bumps

Before releasing a `microsandbox` bump, run the integration suite against the
matching `msb` version.
