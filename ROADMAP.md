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

#### Stack container blocks

- Add a Stack container item that can group normal Card items into a distinct section.
- Keep Stack containers separate from the card-level Stack layout mode.
- Allow items to be dragged into, out of, and between Stack containers, with a clear highlighted drop zone.
- Give each Stack an identifier name, an optional visible heading, and an independently collapsible editor section.
- Support vertical and horizontal item arrangements within a Stack.
- Add Stack-level appearance controls for background, border, padding, spacing, and corner radius.
- Provide Move to top, Move to end, Remove from Stack, and Delete Stack actions alongside drag and drop.
- Preserve each Stack's contents, order, layout, and appearance when the editor is closed and reopened.
- Limit the initial implementation to one level: Stack containers may contain normal Card items but not other Stack containers.

#### Compatibility and safety

- Automatically migrate the existing title, note, fields, and source link into the new block layout without changing how existing cards initially appear.
- Preserve existing field order during migration.
- Add live preview, undo, Restore original layout, and Restore defaults controls.
- Test Reading View, Live Preview, narrow cards, mobile layouts, themes, keyboard operation, renamed variables, missing properties, and existing saved cards.

#### Suggested implementation order

1. **Completed:** Add the block-based card format, multiple notes, movable property items, migration, and non-drag movement controls.
2. **Completed:** Add drag-and-drop ordering, Stack and Grid layouts, column spans, Property tables, live preview, and undo.
3. **Completed:** Add card and block styling, starter layouts, restore controls, and accessibility and compatibility testing.
4. **Completed:** Add single-level Stack container blocks for grouping, arranging, and styling related Card items.

## 1.3.0

> **Target release date: September 4, 2026.** Use September 3 for final validation, installation in the test vault, and smoke testing. Keep the 1.3 scope limited to the related token-syntax, dynamic date/time, and contextual-help work described below.

> **Planning gate:** Before implementation begins, review the complete 1.3 roadmap with the user and iterate on any unclear behavior, format rules, interface choices, scope, or implementation order. Begin development only after the user approves the revised plan.

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

### Dynamic date and time tokens

- Add `{{DATE}}`, using the existing default date format setting.
- Add `{{TIME}}`, using `HH:mm:ss` as its initial default format.
- Support an inline format override, including `{{DATE:DD/MM/YYYY HH:mm:ss}}`, `{{DATE:MM-DD-YY}}`, and `{{TIME:hh:mm:ss A}}`.
- Keep formats case-sensitive so `MM` means month and `mm` means minutes.
- Support full, abbreviated, and single-letter weekdays using `WW`, `www`, and `w`.
- Support useful date and time parts, month names, 12-hour and 24-hour clocks, AM/PM, and escaped literal text.
- Apply the active custom token prefix and suffix to built-in tokens as well as registered variables.
- Reserve the built-in DATE and TIME forms and warn when an existing registered variable conflicts with them.
- Keep built-in tokens out of variable properties, favorites, renaming, Info Cards, and registry editing.

#### Rendering and automatic updates

- Use one shared formatter and resolver in Reading View, Live Preview, suggestions, context menus, insertion, and Copy Markdown.
- Keep date and time tokens raw in Source Mode, code, YAML, math, comments, link destinations, raw HTML, and other protected Markdown contexts.
- Refresh visible tokens only as often as their formats require: every second for seconds, every minute for hours or minutes, and at the date boundary for date-only values.
- Use a single plugin-owned scheduler and release its timers and listeners when the plugin unloads.
- Show a clear warning for unsupported or incomplete formats instead of producing misleading output.

#### Insertion and testing

- Put DATE, TIME, and common formatted examples near the top of token suggestions.
- Add an Insert date or time section to relevant insertion menus and place the caret in the editable portion of a format template.
- Make Copy Markdown copy the displayed date or time value in prose while preserving raw syntax in protected content.
- Test 12-hour and 24-hour time, leading zeroes, seconds, minute and day changes, month and weekday names, invalid formats, local timezones, custom delimiters, plugin reload, and timer cleanup.

### Contextual help controls

- Add a small, consistently styled, keyboard-accessible circled `?` button beside settings and editor controls that need additional explanation.
- Open a focused popup or modal when the button is clicked; do not depend on hovering to reveal the help.
- Allow the popup to close with its close button, Escape, or a click outside it, and return keyboard focus to the originating help button.
- Keep each explanation brief, with examples or a link to a more complete in-plugin reference when the subject is too large for a small popup.
- Add help controls throughout the plugin wherever a label and short description do not adequately explain the behavior, consequences, accepted syntax, or interaction.
- Prioritize token prefix and suffix migration, date and time formats, variable types, property links, appearance inheritance, live-preview delays, Card layout modes, Stack containers, and advanced Card styling.
- Do not add help buttons to self-explanatory actions such as Save, Cancel, Move, or Delete unless testing shows that their behavior is unclear.
- Ensure the buttons and popups work with desktop, mobile, keyboard navigation, screen readers, narrow panels, and different Obsidian themes.

#### Date and time format help

- Place a help button beside the default date and time format settings and beside inline format controls.
- Show a live preview using the current local date and time.
- Include a format-reference table, copyable examples, literal-text instructions, and a clear explanation of case-sensitive parts such as `MM` and `mm`.
- Validate formats as they are entered and use the help popup to explain any unsupported or ambiguous part.

#### Final help review

- Review every Settings section, Variable Link Properties section, Card editor section, and relevant menu before the 1.3 smoke test.
- Add missing help controls where a new user could not reasonably predict the result of a setting.
- Check that the help remains useful without obscuring the normal workflow or crowding narrow layouts.
