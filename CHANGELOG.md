# Changelog

All notable user-visible changes to Variable Links are recorded here.

## 1.3.0 - Unreleased

### Added

- Added configurable Variable Link token prefixes and suffixes with a live example, validation, and continued recognition of previous formats.
- Added a confirmation preview for token-format changes, including safe migration of existing tokens with rollback protection.
- Added multi-term suggestion searches across variable names, display names, source files, and properties, plus explicit `*` searches of resolved variable values.
- Added per-token text-case markers, autocomplete and context-menu controls, and a saved default text case for each Variable Link.
- Added named `FIXED` and `PROPERTY` creation suggestions with inline sources or a prefilled Properties-panel handoff.
- Added `DATE`, `TIME`, and `DATETIME` shortcuts that capture a formatted fixed value, link it to the current note, and complete through suggestions, normal typing, Tab, or Enter.
- Added persistent Autolink profile definitions and a Settings editor for exact-file and folder scopes, ready for the upcoming preview and synchronization workflow.
- Added a read-only Autolink profile preview showing matched notes, note-level overrides, missing properties, misspellings, and naming collisions before any registry changes are allowed.
- Added per-profile controls to disable note overrides or replace the four standard override property names, with validation, reset controls, and preview explanations.
- Added a separately confirmed Autolink action that creates only safe, non-conflicting property-backed Variable Links and records their profile ownership for later synchronization.
- Added a confirmation prompt before deleting an Autolink profile, including notice that its generated Variable Links remain in the registry.
- Added built-in Card snapshots for newly generated Autolink variables, preserving the configured Card-property order and matching the Card Designer presets.
- Added an opt-in Apply all action for replacing same-name Variable Links from an Autolink preview while keeping other warning types excluded.
- Added a main-workspace Management Center foundation opened from the ribbon, command palette, or Settings, ready for registry management activities.
- Added a searchable, sortable Variable Links registry list with ownership and type filters, persistent selections, and per-variable settings and delete actions.
- Added confirmed bulk deletion for selected Variable Links, with hidden-selection disclosure and a cached-token impact count before deletion.
- Added an opt-in deletion choice to replace active tokens with their current text values before removing single or selected Variable Links.

### Changed

- Stacked the Autolink profile description above its full-width editor, aligned the profile fields around a clear center seam, and gave collapsible profile titles H4 styling.

### Fixed

- Replaced whitespace in filename-generated Autolink names with underscores so their tokens remain recognizable.

## 1.2.6 - 2026-08-30

### Added

- Updated a note's token-cache entries whenever the note is opened.
- Added an Update token cache button to Settings for manually rescanning the vault.

### Fixed

- Updated Variable Link file pointers automatically when their referenced note is moved or renamed.

## 1.2.5 - 2026-08-28

### Fixed

- Reloaded Variable Links throughout the plugin whenever a visible, hidden, or externally edited registry file changes.
- Kept long notes scrolling smoothly by avoiding unnecessary Variable Link rerenders and table layout shifts.

## 1.2.4 - 2026-08-24

### Fixed

- Kept already-linked note properties available in editor suggestions while ranking properties without an existing mapping first.

## 1.2.3 - 2026-08-23

### Fixed

- Kept Variable Links raw in code and other non-prose Markdown contexts in Live Preview and Source mode.

## 1.2.2 - 2026-08-23

### Fixed

- Resolved Obsidian plugin-review warnings in Copy Markdown's code-block detection.

## 1.2.1 - 2026-08-23

### Added

- Added Copy Markdown for copying a selected passage, or one right-clicked Variable Link, with resolved values and portable formatting.

### Fixed

- Updated the Variable Link selector immediately when a new variable is created from editor suggestions.
- Allowed an empty Info Card to switch from the simple editor to the block layout editor.

### Changed

- Replaced disabled appearance override controls with a compact summary shown only while a variable uses the default appearance.
- Updated the open Variable Properties panel immediately when default appearance settings or saved colors change.
- Preserved each variable's custom appearance while default appearance is enabled, leaving Restore defaults as the explicit reset action.

## 1.2.0 - 2026-08-23

### Added

- Added single-level Stack containers for grouping Card items vertically or horizontally with optional headings and independent appearance controls.
- Added internal Copy appearance and Paste appearance actions for Card blocks and properties, with compatibility checks and Undo support.
- Added persistent editor labels, independently collapsible Card items, and Collapse all/Expand all controls to the Info Card editor.
- Added horizontal and vertical resizing to the Info Card editor window, with its size remembered when reopened.
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
- Added theme-aware Info Card controls for background, border, corner radius, shadow, maximum width, padding, alignment, and optional CSS snippet classes.
- Added per-block controls for background tone, padding, border, and alignment.
- Added independent property controls for displayed labels, label placement, alignment, and label width without changing the property reference.
- Added Classic stack, Compact grid, and Profile card starter layouts, plus Restore original and Restore defaults actions.

### Changed

- The Card Designer now remembers which blocks and property rows are collapsed for each variable.
- Replaced Card item movement text with compact top, up, down, and end arrow controls that retain tooltips and accessible names.
- Made the Edit Variable and Variable Appearance sections independently collapsible in the Properties panel.
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
- Multi-column cards and Property tables now collapse into readable single-column layouts on small screens.

### Fixed

- Cleaned up resources owned by open panels and dialogs, including preview rendering and pending callbacks, when the plugin unloads.
- Kept the Info Card editor at its current scroll position after dropping or moving layout items.
- Kept cards using the original simple editor out of the new Grid and Stack layout styling.
- Prevented original and Stack cards from collapsing to a narrow strip under responsive Grid sizing.
- Allowed Stage 3 appearance controls to wrap into wider rows without overlapping or clipping.

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
