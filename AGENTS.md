# Project Working Agreement

These instructions apply to the entire repository.

## Branches

- Keep `main` release-ready. Do not develop directly on `main`.
- Start each branch from the latest `origin/main`.
- Use `fixes/<patch-version>` for bug fixes, such as `fixes/1.1.1`.
- Use `features/<minor-version>` for new features, such as `features/1.2.0`.
- Keep fixes and new features in their respective branches. Do not combine them unless the user explicitly requests it.
- After the user confirms the smoke test for an individual fix, commit and push that fix to the active version branch.
- Keep the version branch open for additional work. Do not propose a pull request until the user confirms that the version is complete.
- If a fix is urgent, flag it immediately and ask whether to move directly to release preparation.
- When a patch release reaches `main`, merge the updated `main` into the active feature branch.
- Delete version branches after their release is merged and published.

### Permanent roadmap branch

- Keep a permanent branch named `Roadmap`. Never delete it after a merge or release.
- Edit `ROADMAP.md` only on the `Roadmap` branch. Never edit it directly on `main`, `fixes/*`, `features/*`, release, or other working branches.
- Keep planning-only roadmap changes on `Roadmap`; do not mix plugin implementation changes into roadmap commits.
- Immediately before any fix, feature, or other update branch is ready to be merged, merge the latest `Roadmap` branch into that update branch as the final integration step.
- After merging `Roadmap` into an update branch, resolve any conflicts, rerun the required validation, and do not add further implementation changes without repeating the final roadmap merge check.
- After an update reaches `main`, merge the latest `main` back into `Roadmap` so the permanent branch stays current with released code and project guidance.
- If roadmap edits are accidentally made on another branch, move them to `Roadmap` and restore `ROADMAP.md` on the other branch before continuing.

## Versioning

- Follow semantic versioning:
  - Patch releases contain backward-compatible fixes.
  - Minor releases contain backward-compatible features.
  - Major releases contain breaking changes.
- Use release tags in `x.y.z` format without a `v` prefix.
- Do not bump release metadata for each individual fix. Bump it when the user confirms that the version branch is ready for release.
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

After every successful production build intended for testing, copy `main.js`, `manifest.json`, and `styles.css` into `D:\work\Books\Testing Grounds\.obsidian\plugins\variable-links` before asking the user to smoke-test it.

Do not treat a successful build as a substitute for the smoke test.

## Plans and Presentations

- When the user asks for a plan or presentation, provide it directly in the chat using only plain text or Markdown.
- Do not create PowerPoint files, slide decks, PDFs, documents, images, visualizations, or other separate presentation artifacts.
- Do not use an external presentation format unless the user explicitly changes this rule.

## Pull Requests and Releases

- Do not create or open pull requests. When a branch is ready, tell the user that a pull request is needed.
- Provide a suggested pull-request title and complete pull-request notes in a Markdown code block for the user to copy.
- Include a summary of user-visible changes and validation results in the suggested pull-request notes.
- Do not create or save draft releases. When a merged release is ready, tell the user that a release is needed.
- Provide a suggested release title and complete end-user-facing release notes in a Markdown code block for the user to copy.
- Prepare release notes for `main` only after the corresponding branch is merged.
- Release assets are `main.js`, `manifest.json`, and `styles.css`.
- The user creates and merges pull requests and creates and publishes releases.
- Never replace or delete an existing published release unless the user explicitly requests it.
