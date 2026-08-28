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

> **Target release date: September 4, 2026.** Use September 3 for final validation, installation in the test vault, and smoke testing. Keep the 1.3 scope limited to the related token-syntax, captured date/time, named-creation, and contextual-help work described below.

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

### Captured date and time variable shortcuts

- Add `DATE`, `TIME`, and `DATETIME` creation shortcuts that capture the current moment once and save the result as a normal fixed-value Variable Link.
- Link the created fixed variable to the note where it was inserted so the rendered value also acts as a shortcut back to that note.
- Replace the temporary creation expression with the permanent Variable Link token after the registry entry is saved; date and time values must not continue changing after creation.
- Add editable Default date, Default time, and Default date-time format settings.
- Use the selected shortcut only to choose its default format and automatic-name label: `DATE`, `TIME`, and `DATETIME` must otherwise use exactly the same formatter and support every date and time component.
- Allow an inline format to override the selected default for one creation. For example, `{{DATE:HH:mm:ss}}`, `{{TIME:YYYY-MM-DD}}`, and `{{DATETIME:WW}}` are all valid.
- Keep formats case-sensitive so `MM` means month and `mm` means minutes.
- Support full, abbreviated, and single-letter weekdays using `WW`, `www`, and `w`.
- Support useful date and time parts, month names, 12-hour and 24-hour clocks, AM/PM, and escaped literal text.
- Use the active custom token prefix and suffix for creation expressions and the permanent tokens they produce.

#### Automatic names

- Build automatic names from the first five valid characters of the current filename, followed by the shortcut label and a two-digit sequence.
- Use names such as `{{FileN_Date_01}}`, `{{FileN_Time_01}}`, and `{{FileN_DateTime_01}}`.
- Remove spaces and characters that are unsafe in Variable Link names, and use a clear fallback when the filename does not provide five usable characters.
- Increment the sequence until an unused variable name is found; never overwrite an existing variable.

#### Named creation expressions

- Treat text before `=` as the requested permanent variable name when a creation suggestion is selected.
- Support named date and time creation, including `{{Deadline=DATE}}`, `{{Started=TIME}}`, `{{Created=DATETIME}}`, and formatted forms such as `{{Moment=TIME:YYYY-MM-DD HH:mm}}`.
- Apply the same naming syntax to every supported variable type, including fixed values and property mappings.
- Let `{{Name=FIXED}}` open the fixed-value editor with the name filled in, and let `{{Name=PROPERTY}}` open the property-mapping editor with the name filled in.
- Let a selected unmapped-property suggestion use the text before `=` as its new Variable Link name.
- Replace a successful creation expression with its permanent token, such as replacing `{{Deadline=DATE}}` with `{{Deadline}}`.
- Never overwrite an existing variable with a named creation expression. Offer to insert the existing variable or require a different name.
- Keep creation as an explicit editor or suggestion action; Reading View and background rendering must never create or modify registry entries.

#### Suggestions and formatting help

- Put DATE, TIME, DATETIME, FIXED, and PROPERTY creation entries above ordinary suggestion matches.
- When `=` is present, treat the left side as the proposed name and use the right side to filter creation types, properties, and date/time shortcuts.
- Preview the captured value, resulting permanent token, variable type, and current-note link before the user confirms a creation suggestion.
- Show a clear warning for unsupported, incomplete, or ambiguous formats instead of saving a misleading value.
- Use one date and time format reference for all three shortcuts because their formatter capabilities are identical.

#### Testing

- Test automatic and custom names, filename sanitizing, sequence collisions, existing-name conflicts, and registry-write failures.
- Test fixed-value and property creation through `Name=type`, property suggestions, editor handoff, cancellation, and the final inserted token.
- Test all three shortcuts with date-only, time-only, and combined formats to prove that they share the same formatter.
- Test 12-hour and 24-hour time, leading zeroes, month and weekday names, invalid formats, local timezones, custom delimiters, protected Markdown contexts, and plugin reload.

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

- Place a help button beside the default date, default time, and default date-time format settings and beside inline format controls.
- Show a live preview using the current local date and time.
- Include one shared format-reference table, copyable examples, literal-text instructions, and a clear explanation of case-sensitive parts such as `MM` and `mm`.
- Explain that DATE, TIME, and DATETIME all accept the complete format language and differ only in their editable defaults and automatic-name labels.
- Validate formats as they are entered and use the help popup to explain any unsupported or ambiguous part.

#### Final help review

- Review every Settings section, Variable Link Properties section, Card editor section, and relevant menu before the 1.3 smoke test.
- Add missing help controls where a new user could not reasonably predict the result of a setting.
- Check that the help remains useful without obscuring the normal workflow or crowding narrow layouts.

## 1.4.0

> **Planning gate:** Review and iterate on the complete Card type, template, rule, and population behavior before implementation begins. Keep the first version declarative and understandable rather than adding a scripting language.

### Rule-based Info Card templates

- Add reusable Info Card templates that users can name, describe, preview, and apply to multiple Variable Links.
- Let a template define the Card layout, blocks, tables, labels, appearance, and population rules without being tied to one variable.
- Add user-defined Card types such as Person, Place, Project, Event, or any custom category.
- Keep Card types separate from the existing Fixed value and Property value variable types.
- Allow each Card type to have a default template while permitting multiple templates for the same type.
- Allow a Variable Link to use an automatically selected Card type or a manual Card type override.
- Preserve existing Info Cards exactly until the user explicitly applies a template or enables automatic application.

#### Template manager

- Add a template manager for creating a blank template, saving the current Card as a template, duplicating, renaming, reordering, previewing, and deleting templates.
- Give every template a stable internal identifier so renaming it does not break Card types or rules.
- Let users choose whether saving a Card as a template includes its layout, appearance, content blocks, population rules, or any combination of those parts.
- Show which Card types and rules use a template before allowing it to be deleted.
- Keep a deleted or modified template from damaging existing Cards by storing the applied Card configuration independently.
- Support both the original simple Card layout and the block layout, while making block layouts the more capable template format.

#### Card type and rule builder

- Add an understandable rule builder with enabled/disabled rules, drag ordering, and explicit priority.
- Allow rules to match variable type, variable name, source file or folder, linked property name, file link presence, note tags, and selected frontmatter properties or values.
- Support Match all and Match any condition groups without allowing arbitrary executable code.
- Let a matching rule assign a Card type, choose a template, and define how the template should be populated.
- Stop after the first matching rule by default, with a deliberate option to continue to compatible lower-priority rules.
- Make a manual Card type or template selection override automatic rules until the user chooses to resume automatic matching.
- Include a rule tester that explains which rule matched a selected Variable Link and why higher-priority rules did not match.

#### Automatic population

- Evaluate Card rules when a new Variable Link is created and when the user explicitly asks to re-evaluate an existing Card.
- Provide user-selectable behavior for automatic application, confirmation before applying, or suggestion only.
- Let templates populate content from the variable name, display name, resolved value, variable type, source file, source path, property name, optional file link, tags, and selected note properties.
- Allow template property blocks and tables to use explicit property names, include and exclude lists, or simple name-pattern rules.
- Let population rules hide an optional block, leave it empty, or use fallback text when its source value is unavailable.
- Treat applying a template as a snapshot: later template or rule changes must not silently rewrite existing customized Cards.
- Add explicit Re-evaluate rules and Reapply template actions for users who want to update an existing Card.

#### Applying and reapplying templates

- Preview the resulting Card and summarize the proposed changes before replacing existing content or appearance.
- Offer Fill missing items only as the safest default for an existing Card.
- Also offer Replace layout, Replace appearance, and Replace the complete Card as deliberate choices.
- Preserve an undoable copy of the prior Card configuration whenever a template is applied or reapplied.
- Support applying a template to one Variable Link first, then add a separately confirmed bulk-application workflow after the single-Card behavior is proven safe.

#### Card editor integration

- Add Card type, Applied template, and Rule status controls to the Card properties panel.
- Add Apply template, Re-evaluate rules, Resume automatic matching, and Save as template actions in appropriate Card editor menus.
- Clearly distinguish a manually selected template from one chosen by an automatic rule.
- Keep template and rule controls usable in narrow panels, on mobile, with keyboard navigation, and with screen readers.
- Add the contextual `?` help controls established in 1.3 wherever template inheritance, matching, or replacement behavior needs explanation.

#### Compatibility and testing

- Test existing simple and block-layout Cards to confirm they remain unchanged until the user acts.
- Test template creation, duplication, renaming, deletion warnings, stable identifiers, previews, and undo restoration.
- Test rule priority, Match all and Match any groups, manual overrides, no-match behavior, disabled rules, and rule explanations.
- Test missing properties, renamed files and variables, changed tags, fixed and property variables, deleted templates, and registry reloads.
- Test single-Card and bulk application, each replacement mode, narrow layouts, mobile, themes, keyboard operation, and plugin unload cleanup.

#### Suggested implementation order

1. Define Card types and the reusable template format, then add the template manager and Save as template workflow.
2. Add manual template application, previews, replacement modes, and undo before enabling automation.
3. Add the declarative rule builder, priorities, manual overrides, and rule explanations.
4. Add automatic population, explicit re-evaluation, and the optional bulk workflow after single-Card smoke testing succeeds.
