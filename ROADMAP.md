# Roadmap

This document records planned improvements to Variable Links. Plans may change as features are designed and tested. Completed work belongs in `CHANGELOG.md`.

## 1.2.0

### Configurable Info Card delays

- Add a separate hover-delay setting for Reading View.
- Default the Reading View delay to 0.5 seconds.
- Let the Live Preview delay increase in 0.25-second increments, starting at 1 second.
- Keep the Live Preview default at 3 seconds.
- Preserve compatible delay values already saved by users.

### Favorite control placement

- Move the Favorite checkbox to the top right of the Link panel, beside the selected Variable Link name and above the mapping editor.
- Save Favorite changes immediately without requiring the mapping form to be saved.
- Keep a Favorite option available while creating a new variable.
- Preserve the current Favorite state when a mapping is edited or renamed.
- Keep the variable name and Favorite control usable when the sidebar is narrow.

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

### Switch token submenu

- Add a Switch token submenu that is enabled only when the context menu is opened inside a complete Variable Link token.
- Keep Switch token disabled outside tokens while Insert and Insert favorite remain available.
- Keep Insert and Insert favorite disabled inside tokens.
- Show the current token as a disabled item at the top of the submenu.
- List favorite variables first with a star, followed by a separator and the remaining variables in alphabetical order.
- Do not duplicate favorite variables in the regular list.
- Disable Switch token when no alternative configured variables are available.
- Replace the entire existing token with the selected token as one undoable editor action.
- Move the caret to the end of the replacement token.
- Allow missing or deleted tokens to be switched even when Properties and Favorite are unavailable.
- Keep submenu entries limited to variable names so the menu remains compact and stable.
- Consider adding Search all and a Switch Variable Link token command after the basic submenu is proven usable with large registries.
- Test Source Mode, Live Preview, keyboard navigation, missing variables, multiple tokens on one line, line boundaries, favorites ordering, insertion disabling, caret placement, and Undo.
