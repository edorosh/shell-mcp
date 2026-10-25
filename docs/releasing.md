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
   - Check out the `v1.0.0` tag cleanly (`git status` shows nothing).
   - `npm ci`
   - `npm login`
   - `npm publish`

   This version has no provenance. CI-published versions get it.
2. Add the trusted publisher (GitHub Actions, repository `edorosh/shell-mcp`,
   workflow `release.yml`, no environment), either:
   - on npmjs.com: the package, Settings, Trusted publishing; or
   - from the command line (npm 11.15.0 or newer, 2FA on):
     `npm trust github @edorosh/shell-mcp --file release.yml --repo edorosh/shell-mcp --allow-publish`
3. The first CI publish must happen within 2 days of adding the trusted
   publisher, so cut the next release soon after.

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
