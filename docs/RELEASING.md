# Releasing

Releases are published to npm by GitHub Actions through **npm trusted
publishing (OIDC)** — no long-lived npm token is stored in the repository.

## One-time setup (maintainer, interactive 2FA)

1. Make sure the package exists on npm (the first release can be published
   manually: `npm publish --access public`).
2. On npmjs.com → the package → **Settings → Trusted Publisher**, add a GitHub
   Actions publisher:
   - Organization or user: `guyue55`
   - Repository: `dsh-disk-panel`
   - Workflow filename: `release.yml`
   - Environment: leave empty
   - Permissions: enable **npm publish**
3. Or configure it from the CLI (requires npm >= 11.5.1 / 12 and an interactive
   2FA challenge):

   ```bash
   npx npm@latest trust github dsh-disk-panel \
     --repo guyue55/dsh-disk-panel \
     --file release.yml \
     --allow-publish -y
   ```

## Cutting a release

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Run the checks locally:

   ```bash
   node --check index.js && node --check client.js
   npm test
   ```

3. Commit, tag, push:

   ```bash
   git push origin main
   git tag v0.1.1
   git push origin v0.1.1
   ```

4. The `release` workflow runs on the tag, checks that the tag matches the
   package version, runs `npm test`, and publishes with
   `npm publish --provenance --access public` using OIDC. No `NPM_TOKEN` secret
   is needed.
5. Push a GitHub Release with the prebuilt tarball (optional but keeps the
   market's `tarball:` fallback working). Keep the asset name version-free:

   ```bash
   npm pack --pack-destination /tmp
   cp /tmp/dsh-disk-panel-<version>.tgz /tmp/dsh-disk-panel.tgz
   gh release create v<version> /tmp/dsh-disk-panel.tgz
   ```

## Manual fallback

If trusted publishing is unavailable, a maintainer can publish locally with an
interactive 2FA challenge (`npm publish --access public`), or run the workflow
on a machine/CI with an `NPM_TOKEN` there is no fallback secret wiring in this
repository on purpose.
