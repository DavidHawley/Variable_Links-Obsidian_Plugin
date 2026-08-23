# Roadmap

This document records planned improvements to Variable Links. Plans may change as features are designed and tested. Completed work belongs in `CHANGELOG.md`.

## 1.2.0

> **Scope closed:** The planned feature set for 1.2.0 is complete. Do not add further features to this release. Changes that clarify, implement, test, or correct the items already listed may still be made. Record additional feature ideas for a later version.

### Info Card layout and style editor

- Add a larger Info Card editor opened from the Card tab.
- Build cards from movable Title, Note, referenced Property, Property table, Divider, and Source link blocks.
- Allow multiple independent Markdown Note blocks.
- Make every referenced property independently movable and preserve its property link while it is rearranged.
- Allow referenced properties to be reordered, moved between rows and columns, displayed independently, or grouped into a Property table.
- Let users customize a property's displayed label, label placement, alignment, and width without changing its reference.
- Provide accessible Move up, Move down, and Move to column controls in addition to drag and drop.

#### Layout modes

- Add a Stack mode that displays each block on its own row.
- Add a Grid mode with one to four columns, automatic rows, adjustable spacing, and full, half, third, or quarter-width block spans.
- Make grid layouts collapse to one column when the card is narrow.
- Add a Property table mode with an adjustable column count, automatic or fixed rows, and movable property cells.
- Begin with equal table-column widths and consider individually adjustable widths after the basic editor is proven usable.
- Avoid absolute positioning so cards remain readable across window sizes and devices.

#### Styling

- Add card-level controls for background, border, corner radius, shadow, maximum width, spacing, and text alignment.
- Add limited block-level controls for background tone, padding, divider or border, alignment, label visibility, and column span.
- Prefer theme-aware colors and reusable presets.
- Keep optional advanced CSS card-level rather than attaching raw CSS to every block.

#### Compatibility and safety

- Automatically migrate the existing title, note, fields, and source link into the new block layout without changing how existing cards initially appear.
- Preserve existing field order during migration.
- Add live preview, undo, Restore original layout, and Restore defaults controls.
- Test Reading View, Live Preview, narrow cards, mobile layouts, themes, keyboard operation, renamed variables, missing properties, and existing saved cards.

#### Suggested implementation order

1. Add the block-based card format, multiple notes, movable property items, migration, and non-drag movement controls.
2. Add drag-and-drop ordering, Stack and Grid layouts, column spans, Property tables, live preview, and undo.
3. Add card and block styling, starter layouts, restore controls, and accessibility and compatibility testing.

### Fixed and property value variables

- Support two user-facing variable types: **Fixed value** and **Property value**.
- Treat existing variables without a stored type as Property value variables so existing registries continue to work without manual migration.
- Add **New fixed value** and **New property value** actions to the Variable Link selector dropdown.
- Do not create or save a new variable until the user completes its form and confirms the normal save action.

#### Fixed value

- Let the user enter a value directly instead of reading it from a note property.
- Allow an optional file link; a fixed variable without one should display normally and do nothing when clicked.
- Support the existing display name, Favorite, appearance, card, rename, insertion, and token-switching features.
- Preserve text exactly as entered rather than automatically converting numbers, dates, checkboxes, or other value types.
- Allow an intentionally empty fixed value.

#### Property value

- Keep the current behavior of resolving the variable value from a property in a linked note.
- Continue to require a valid property reference before a Property value variable can be saved.
- Keep existing display name, Favorite, appearance, card, rename, insertion, and token-switching behavior.

#### Changing types safely

- Add a Variable type dropdown to the properties panel for existing variables.
- Show a confirmation dialog before changing the type, explain the effect of the change, and change nothing if the user cancels.
- Treat a confirmed type selection as an unsaved form change; do not update the registry or rendered tokens until the user saves the form.
- When changing from Property value to Fixed value, default to copying the currently resolved property value when no previous fixed value exists.
- When changing from Fixed value to Property value, restore its previous property settings or show blank required property fields if none were previously saved.

#### Data preservation and compatibility

- Store an explicit variable type while retaining the fields for both types in the registry.
- Hide inactive fields in the panel without deleting their saved values, allowing users to switch back without re-entering their previous information.
- Keep the variable name, stable identifier, display name, Favorite state, appearance, card settings, and optional link data intact when its type changes.
- Ensure only the active type's value source affects rendering and resolution.
- Test new and existing registries, repeated type changes, canceled confirmations, unsaved changes, empty fixed values, optional file links, renamed variables, Favorites, Insert, Switch token, Source Mode, Live Preview, Reading View, and Info Cards.
