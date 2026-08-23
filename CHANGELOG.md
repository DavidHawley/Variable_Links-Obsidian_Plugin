# Changelog

All notable user-visible changes to Variable Links are recorded here.

## 1.2.0 - Unreleased

### Added

- Added a configurable Info Card hover delay for Reading View.
- Added a context-menu submenu for switching complete Variable Link tokens, with favorites listed first.
- Added Fixed value variables with optional file links alongside the existing Property value variables.
- Added variable-type creation choices and confirmed, reversible type switching in the properties panel.
- Added direct editing of text, number, and true/false values stored in linked note properties.
- Added a larger block-based Info Card editor with multiple Notes, standalone Properties, Property tables, Dividers, Source links, and accessible movement controls.
- Added a Card-tab checkbox for switching between the original simple editor and the block layout editor.
- Added Stack and responsive Grid Info Card layouts with one to four automatic columns, adjustable spacing, and per-block width controls.
- Added drag-and-drop ordering, an in-editor live preview, and up to 50 steps of undo while editing a card layout.
- Added one-to-four-column Property tables with automatic or fixed minimum rows and controls for moving property cells within or between tables.

### Changed

- Improved the visual separation of section titles in the Variable Link Properties panel.
- Live Preview Info Card delays can now be adjusted in quarter-second increments starting at one second.
- Moved the Favorite control beside the selected Variable Link name and made changes save immediately.
- Moved variable type selection above the editor and made the active Value or Property link field occupy the same position.
- Removed the redundant variable-type label from the panel heading.
- Organized the selected variable, resolved value, and actions in a visible summary table.
- Simplified the Actions row border so only its top divider remains visible.
- Kept the Properties and Info Card save buttons visible above the bottom-left of their panels while scrolling.
- Updated rendered tokens immediately after their linked property value is edited from the panel.
- Aligned panel field labels beside controls when space allows, stacked them in narrow panels, and limited Fixed values to a single line.
- Added consistent punctuation to field labels and kept multiline text areas beneath their labels.
- Moved the Info Card field-format instructions beneath the Fields input as hint text.
- Existing Info Cards can seed the block layout while preserving their original content order and initial appearance, and both editor configurations are retained when switching.
- Separated comma-delimited entries in block Property controls so linked `[[File]]#property` values resolve correctly.
- Grid Info Cards collapse to a single column when the available card width becomes narrow.

### Fixed

- Kept the Info Card editor at its current scroll position after dropping or moving layout items.
- Kept cards using the original simple editor out of the new Grid and Stack layout styling.
- Prevented original and Stack cards from collapsing to a narrow strip under responsive Grid sizing.

## 1.1.1 - 2026-08-22

### Fixed

- Info Cards now close reliably when the pointer leaves them, the user clicks elsewhere, or Obsidian loses focus.
- Reading View Info Cards now wait half a second before opening to reduce accidental popups.
- Insert and Insert favorite are now disabled when the context menu is opened inside an existing Variable Link token.

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
