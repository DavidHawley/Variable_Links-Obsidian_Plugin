# Changelog

All notable user-visible changes to Variable Links are recorded here.

## 1.2.0 - Unreleased

This section is reserved for new backward-compatible features.

## 1.1.1 - Unreleased

### Fixed

- Info Cards now close reliably when the pointer leaves them, the user clicks elsewhere, or Obsidian loses focus.
- Reading View Info Cards now wait half a second before opening to reduce accidental popups.

## 1.1.0 - 2026-08-22

### Added

- Added Link and Card tabs to the Variable Link Properties panel.
- Added searchable controls for choosing a property link and an independent file link.
- Added global and per-variable appearance controls for bold, italic, underline, highlight, color, and opacity.
- Added six reusable custom color swatches and support for the current Obsidian theme color.
- Added Info Cards to Live Preview with a configurable hover delay.
- Added global and per-card controls for disabling Live Preview hover cards.
- Added a control for restoring a variable's default appearance.

### Changed

- Info Cards now open beside the pointer and remain within the visible window.
- The caret now moves to the end of an inserted or replaced Variable Link.
- Updated the README to focus on using the plugin.

## 1.0.1 - 2026-08-21

### Fixed

- Resolved Obsidian plugin-review warnings and strengthened source checks.
- Removed unsupported fields from the plugin manifest.

## 1.0.0 - 2026-08-21

### Added

- Added Variable Links that point to frontmatter properties and update when variables are renamed.
- Added file hyperlinks, customizable hover Info Cards, insertion commands, favorites, and context menus.
- Added automated checks and draft-release creation with GitHub Actions.
