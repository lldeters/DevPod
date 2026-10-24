# Releasing

Kiro installs extensions from [Open VSX](https://open-vsx.org), so that is where this extension is
published. (The Visual Studio Marketplace does not accept extensions that use a proposed API such as
`resolvers`, and Kiro does not use it.) Publishing is done by the
[release workflow](../.github/workflows/release.yml) when a tag `v<version>` is pushed.

## Once, before the first release

1. **Test the build in Kiro.** Install the VSIX from the CI run of the commit you want to release
   (the run's artifact `devcontainers-kiro-vsix`) and go through [TESTING.md](TESTING.md). Record
   the result under _Verified results_ there.
2. **Put the code on `main` and make the repository public.** On Open VSX, the links in the README
   point to `https://github.com/lldeters/DevPod/blob/HEAD/...`, that is, to `main` of this
   repository; the issue link and the security policy need it too. Merge the release branch into
   `main`, then _Settings → General → Danger Zone → Change repository visibility → Public_.
3. **Turn on private vulnerability reporting**, which [SECURITY.md](../SECURITY.md) asks reporters to
   use: _Settings → Advanced Security_ (or _Code security_) _→ Private vulnerability reporting →
   Enable_.
4. **Set up Open VSX** (the
   [publishing guide](https://github.com/eclipse/openvsx/wiki/Publishing-Extensions) has the
   current details):
   1. Log in at <https://open-vsx.org> with the GitHub account `lldeters`.
   2. In your profile, connect an Eclipse Foundation account and sign the Open VSX Publisher
      Agreement.
   3. Create an access token (_Settings → Access Tokens_).
   4. Create the namespace once. It must equal `publisher` in `package.json`:
      `npx ovsx create-namespace lldeters -p <token>`
   5. Optional: have the namespace verified, so the listing does not show it as unverified. This is
      requested with an issue at <https://github.com/EclipseFdn/open-vsx.org/issues>
      (_Claim namespace ownership_).
5. **Give the workflow the token:** _Settings → Secrets and variables → Actions → New repository
   secret_, name `OVSX_PAT`, value the token.
6. Recommended: limit who may push tags matching `v*` (_Settings → Rules → Rulesets_, target tags),
   since pushing such a tag publishes.

## Every release

1. Set the version (it is `0.1.0` for the first release already):
   `npm version <x.y.z> --no-git-tag-version` (updates `package.json` and `package-lock.json`).
2. In [CHANGELOG.md](../CHANGELOG.md), give the version a dated heading: `## <x.y.z> (YYYY-MM-DD)`.
   The workflow refuses to publish without it.
3. Commit, and merge into `main`.
4. Tag the commit on `main` and push the tag:
   `git tag v<x.y.z> && git push origin v<x.y.z>`
5. Watch the _Release_ workflow in the _Actions_ tab. It checks tag, version and changelog, runs the
   whole CI including the Docker and Kubernetes end-to-end tests, publishes the VSIX that CI built
   to Open VSX and creates a GitHub release with that VSIX and the changelog section as notes.
   The listing is then at <https://open-vsx.org/extension/lldeters/devcontainers-kiro>.

If a step fails after CI passed (for example a missing or expired token), fix the cause and use
_Re-run failed jobs_; publishing skips a version Open VSX already has. A published version cannot be
replaced: to fix a release, publish the next version.

## By hand

Without the workflow: `npm ci && npm run build -- --production && npx vsce package`, then
`npx ovsx publish devcontainers-kiro-<x.y.z>.vsix -p <token>`.
