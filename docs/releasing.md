# Releasing

A pushed tag `vX.Y.Z` runs `.github/workflows/release.yml`. It checks the tag
against `package.json` and `CHANGELOG.md`, runs typecheck, tests and the pack
check, publishes `@edorosh/shell-mcp` to npm and creates a GitHub release from
the changelog section. There is no npm token; npm trusts the workflow through
OIDC.

## One-time setup

1. On npmjs.com, open the package settings and add a trusted publisher:
   GitHub Actions, repository `edorosh/shell-mcp`, workflow `release.yml`,
   no environment.
2. If npmjs.com lets you add the trusted publisher before the package exists,
   do that and let CI publish 1.0.0 (see "Each release").
3. Otherwise publish 1.0.0 by hand first, then configure the trusted
   publisher as in step 1:
   - Check out the tagged commit cleanly (`git status` shows nothing).
   - `npm ci`
   - `npm login`
   - `npm publish`

   This version has no provenance. CI-published versions get it.

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
