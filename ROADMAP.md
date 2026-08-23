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

1. **Completed:** Add the block-based card format, multiple notes, movable property items, migration, and non-drag movement controls.
2. **Completed:** Add drag-and-drop ordering, Stack and Grid layouts, column spans, Property tables, live preview, and undo.
3. Add card and block styling, starter layouts, restore controls, and accessibility and compatibility testing.

## 1.3.0

### Custom Variable Link token syntax

- Add Token prefix and Token suffix settings while keeping `{{` and `}}` as the defaults.
- Show a live example of the resulting token format in Settings.
- Treat configured prefix and suffix characters literally rather than as pattern syntax.
- Centralize token parsing and formatting so Reading View, Live Preview, insertion, switching, caret detection, renaming, and token caching use the same rules.

#### Validation and compatibility warnings

- Require nonempty prefix and suffix values that do not contain line breaks or consist only of whitespace.
- Prevent identical prefix and suffix values and place a reasonable length limit on both fields.
- Prevent variable names from containing the active prefix or suffix.
- Warn about formats that conflict with Obsidian or Markdown syntax, including wikilinks, embeds, code markers, and comments.
- Keep the existing default format fully compatible for users who do not change the settings.

#### Changing formats and migration

- Show the current format, proposed format, and a sample token in a confirmation dialog before applying a change.
- Offer Cancel, Use for new tokens only, and Migrate existing tokens actions.
- Make Migrate existing tokens the recommended action.
- Use the verified token cache to update only Variable Link tokens rather than replacing similar text indiscriminately.
- Prepare changes before writing files, preserve rollback information, and leave the previous format active if migration cannot complete safely.
- When Use for new tokens only is selected, recognize both the active and previous formats temporarily.
- Provide a way to stop recognizing a previous format after migration or manual cleanup is complete.

#### Testing

- Test custom formats in Source Mode, Live Preview, Reading View, Insert, Favorites, Switch token, Properties, renaming, missing variables, token caching, and Info Cards.
- Test multiple active and legacy formats, migration cancellation, partial-write recovery, conflicting Markdown syntax, repeated tokens, and tokens at line boundaries.
