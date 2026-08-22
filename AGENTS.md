# Project Working Agreement

These instructions apply to the entire repository.

## Branches

- Keep `main` release-ready. Do not develop directly on `main`.
- Start each branch from the latest `origin/main`.
- Use `fixes/<patch-version>` for bug fixes, such as `fixes/1.1.1`.
- Use `features/<minor-version>` for new features, such as `features/1.2.0`.
- Keep fixes and new features in their respective branches. Do not combine them unless the user explicitly requests it.
- When a patch release reaches `main`, merge the updated `main` into the active feature branch.
- Delete version branches after their release is merged and published.

## Versioning

- Follow semantic versioning:
  - Patch releases contain backward-compatible fixes.
  - Minor releases contain backward-compatible features.
  - Major releases contain breaking changes.
- Use release tags in `x.y.z` format without a `v` prefix.
- Keep the version synchronized in `manifest.json`, `package.json`, the root and package entries in `package-lock.json`, and `versions.json`.
- Record the correct minimum supported Obsidian version in `versions.json` for every release.

## Changelog

- Update `CHANGELOG.md` as part of every user-visible change.
- Write entries for plugin users, using plain language rather than implementation details.
- Put fixes under the pending patch release and features under the pending minor release.
- Use `Added`, `Changed`, `Fixed`, and `Removed` headings as appropriate.
- Replace `Unreleased` with the publication date when a release is published.

## Validation

Before a pull request or release:

1. Run `npm ci` when dependencies need to be restored.
2. Run `npm run lint`.
3. Run `npm run build`, which performs the TypeScript check and production build.
4. Verify that `main.js`, `manifest.json`, and `styles.css` exist and are not empty.
5. Confirm all release version metadata agrees.
6. Install the build in the test vault and complete a smoke test when the change affects plugin behavior.

Do not treat a successful build as a substitute for the smoke test.

## Pull Requests and Releases

- Summarize user-visible changes and validation results in every pull request.
- Prepare releases from `main` only after the corresponding branch is merged.
- Release assets are `main.js`, `manifest.json`, and `styles.css`.
- The user performs the final pull-request merge and release publication unless they explicitly delegate those actions.
- Never replace or delete an existing published release unless the user explicitly requests it.
