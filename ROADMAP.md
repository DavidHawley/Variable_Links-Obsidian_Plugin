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

> **Target release date: September 24, 2026.** Use September 23 for final validation, installation in the test vault, and smoke testing. Keep the 1.3 scope limited to the related token-language and displayed-text case controls, file and folder autolinking, basic Card population, captured date/time, named-creation, and contextual-help work described below.

> **Planning gate approved:** The revised 1.3 direction was approved on August 31, 2026. Review any newly discovered ambiguity with the user before expanding the agreed scope.

### Custom Variable Link token syntax

- Add Token prefix and Token suffix settings while keeping `{{` and `}}` as the defaults.
- Show a live example of the resulting token format in Settings.
- Treat configured prefix and suffix characters literally rather than as pattern syntax.
- Centralize token parsing and formatting so Reading View, Live Preview, insertion, switching, caret detection, renaming, and token caching use the same rules.
- Establish a consistent creation grammar using `Name=TYPE:source`, with the source omitted when the selected type opens an editor.
- Support expressions such as `{{Price=PROPERTY:[[Items/Sword]]#price}}`, `{{Status=FIXED:Draft}}`, and `{{Started=DATE:YYYY-MM-DD}}`.
- Support quoted fixed values such as `{{Summary=FIXED:"Work in progress"}}`, including clear escaping rules for quotes and active token delimiters.
- Keep folder scans and other bulk operations out of token expressions. A token may create or reference one Variable Link, but it must not silently mutate an entire folder.

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
- Test unquoted and quoted creation sources, escaped characters, explicit file-property links, incomplete expressions, and malformed type or source separators.

### Displayed-text case controls

- Add compact, matching markers inside a Variable Link token to change only its displayed value:
  - `{{.Name.}}` lowercases the first letter.
  - `{{..Name..}}` lowercases every letter.
  - `{{'Name'}}` uppercases the first letter.
  - `{{''Name''}}` uppercases the first letter of each word.
  - `{{'''Name'''}}` uppercases every letter.
- Treat `Name` as the referenced permanent Variable Link in every example; markers must never become part of the registry lookup or alter the stored value.
- Require the same marker and repetition count at both ends. Unmatched punctuation remains ordinary token-name or suggestion-query text.
- Give an exact existing variable name priority over interpreting its leading and trailing punctuation as case markers, preserving compatibility with existing names such as `'Name'`.
- Warn when a new variable name has the same shape as reserved case-marker syntax, while continuing to support already-existing exact names.
- Apply case conversion to the final displayed text using Unicode-aware operations, leaving numbers and punctuation unchanged.
- Apply token-level case consistently in Reading View, Live Preview, links, and Copy Markdown without changing link destinations, Info Card data, source properties, or fixed values.
- Preserve the case marker when renaming a variable, changing token delimiters, migrating token formats, switching a token, or rebuilding the token cache.

#### Defaults and token controls

- Add a Default text case dropdown near Display name in the Variable Properties panel with Keep original, Lowercase first letter, Uppercase first letter, Capitalize each word, lowercase all, and UPPERCASE ALL choices.
- Store the default on the Variable Link definition rather than in global appearance settings.
- Let a case marker on an individual token override the variable's default; a bare token uses the saved default.
- Add the same choices to the token context menu so a token can be changed without manually remembering or editing punctuation.
- Make suggestions recognize an opening case marker, show the active case mode, and insert the selected Variable Link with a matching closing marker.

#### Case-control testing

- Test every marker with lowercase, uppercase, mixed-case, Unicode, punctuation-leading, numeric, boolean, array, empty, and missing values.
- Test bare tokens with every per-variable default and verify that token-level markers override the default.
- Test existing punctuation-shaped variable names, unmatched markers, custom and previous token delimiters, autocomplete, token switching, renaming, migration, token caching, links, and Copy Markdown.
- Confirm protected Markdown contexts remain raw and that case formatting never modifies registry data or source-note properties.

### Multi-term and value suggestion search

- Allow spaces in an editor suggestion query and treat the query as case-insensitive, space-separated search terms.
- Require every ordinary search term to match at least one searchable field, while allowing different terms to match the variable name, display name, source file path, or property name.
- Let a query such as `{{john stat` find a Status variable sourced from `Characters/John Smith.md`.
- Keep existing variables ahead of property-creation suggestions, and keep properties without an existing mapping ahead of already-mapped properties.
- Rank exact matches first, followed by starts-with, whole-word, and substring matches.
- Preserve the active custom token prefix and suffix when triggering suggestions and inserting the selected result.

#### Resolved-value search

- Treat one leading `*` in the suggestion query as an explicit resolved-value search operator.
- Search only existing variables in value mode; do not include unmapped-property creation suggestions.
- Require every term after `*` to match the current resolved value, with support for text, numbers, true/false values, and readable array values.
- Show the matched value beneath each result and truncate very long previews without changing the stored value.
- Resolve values only while value mode is active, cache them briefly while the user continues typing, and discard stale asynchronous results when the query changes.
- Treat the leading `*` only as a suggestion operator. Never include it in the Variable Link token inserted after a result is selected.

#### Suggestion-search testing

- Test terms that match one field, terms split across multiple fields, case differences, repeated spaces, no matches, and ranking ties.
- Test fixed and property values, arrays, numbers, booleans, empty or missing values, long previews, changed property values, and rapid query changes.
- Test normal and value searches with the default format, custom formats, previous recognized formats, and token suffixes already present after the caret.

### File and folder autolinking

- Add reusable Autolink profiles that can target one file or a folder, with an option to include subfolders.
- Store profiles in the Variable Links registry so they remain portable and synchronized with the rest of the plugin data.
- Let each matching note generate one managed Variable Link by default, using the note filename or a configurable name pattern when the note does not provide an explicit name.
- Let a profile define the value property, built-in Card preset, and ordered list of note properties to include in the Card.
- Keep generated entries compatible with the existing registry, GUID, rename, token-cache, file-move, property-link, and Card systems.
- Record which profile manages each generated entry so synchronization can distinguish generated data from manual customization.

#### Note properties and overrides

- Recognize the following canonical note properties:
  - `variablelink_name` for the permanent Variable Link name.
  - `variablelink_value_property` for the note property whose value the Variable Link displays.
  - `variablelink_template` for the stable built-in Card preset or future custom template identifier.
  - `variablelink_card_properties` for an ordered YAML list of note properties shown on the Card.
- Use the correctly spelled `variablelink_template` as the documented field name and show a clear warning for likely misspellings rather than silently ignoring them.
- Treat note properties as overrides rather than requiring every matching note to repeat its folder defaults.
- Apply configuration in this order: explicit note properties, an exact-file profile, the closest matching folder profile, broader parent-folder profiles, and plugin defaults.
- Require a distinct Variable Link name and value source. Do not assume that a display value, filename, property name, and permanent token name are interchangeable.

#### Scan, preview, and synchronization

- Add commands or Settings actions to preview autolinks for the current file, a selected folder, or all enabled profiles.
- Before applying changes, list proposed additions, safe updates, naming collisions, invalid properties, unmatched notes, and entries that would leave a profile's scope.
- Make preview and explicit confirmation the initial 1.3 workflow. Design the profile data for a later opt-in automatic mode without introducing silent background registry mutations in the first release.
- Never overwrite a manually customized Variable Link or Card without explicit confirmation.
- Resolve names deterministically and never replace an existing unrelated variable when a generated name collides.
- When a source note is renamed or moved, update its managed file pointer. If it leaves the profile scope, flag it for review instead of deleting it automatically.
- When a profile or note property changes, update only the parts still managed by that profile and preserve manual overrides.
- Provide a rescan action that is safe to repeat and produces no duplicate variables or Card items.

#### Basic Card population and presets

- Add stable identifiers for a small set of built-in Card presets suitable for simple, compact, and property-focused Cards.
- Let `variablelink_template` select one of these presets in 1.3 while reserving the same identifier field for the custom template system planned for 1.4.
- Populate the Card from `variablelink_card_properties` or the profile's ordered Card-property list.
- Preserve the listed order, identify missing properties in the preview, and avoid adding the same property twice.
- Apply generated Card configuration as a snapshot so later profile changes do not silently replace a customized Card.
- Keep custom template creation, the visual template manager, advanced rule building, and bulk template replacement in 1.4.

#### Managed-variable bulk tools

- Add a management view that lists Variable Links created by each Autolink profile, including entries whose original profile was later deleted.
- Allow users to select individual managed Variable Links or select every managed link belonging to one profile.
- Add a separately confirmed bulk-delete action that removes only selected entries carrying the matching Autolink ownership metadata; never include manual or unrelated Variable Links.
- Before deletion, show how many cached tokens will become unresolved and clearly state that note text will remain unchanged.
- Add a mass-rename workflow based on a revised profile name pattern, with a complete old-name/new-name preview before confirmation.
- Detect duplicate or occupied names before renaming and cancel the whole batch if every rename cannot be completed safely.
- Reuse GUID-backed token rename and rollback protection so confirmed mass renames update verified tokens without broad text replacement.
- Keep selective deletion and mass rename explicit user actions; profile deletion alone must not delete or rename generated Variable Links.

#### Autolinking testing

- Test exact-file and nested-folder profiles, subfolder inclusion, precedence, note overrides, naming patterns, collisions, missing value properties, and repeated scans.
- Test note creation, rename, move into and out of scope, property changes, deleted files, registry reloads, and plugin reloads.
- Test generated property links, token renaming, Card-property order, missing Card properties, manual Card customization, and all built-in presets.
- Test preview cancellation and partial failures to confirm that no unrelated registry entry or note is modified.

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
- Support complete one-line creation expressions such as `{{Price=PROPERTY:[[Items/Sword]]#price}}` and `{{Status=FIXED:Draft}}` when their source is valid.
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

### Suggested implementation order

1. Centralize token parsing and formatting, then add the `Name=TYPE:source` grammar, quoted sources, custom delimiters, and migration support.
2. Add multi-term suggestion matching, ranking, and explicit resolved-value search.
3. Add displayed-text case markers, per-variable defaults, autocomplete, context-menu controls, and compatibility handling.
4. Define the Autolink profile, managed-entry, note-property, precedence, and preview data models without changing notes or the registry automatically.
5. Add exact-file and folder scanning, preview, conflict handling, confirmed synchronization, file-move behavior, and explicit managed-variable bulk tools.
6. Add built-in Card preset selection and ordered Card-property population while keeping the full custom template system in 1.4.
7. Add captured date and time shortcuts and the shared formatter on top of the centralized token language.
8. Add contextual help, complete protected-context and compatibility testing, install the build in the test vault, and perform the final smoke test.

## 1.4.0

> **Planning gate:** Review and iterate on the complete Card type, template, rule, and population behavior before implementation begins. Build on the Autolink profiles, stable template identifiers, and basic Card population introduced in 1.3 rather than creating a second file and folder matching system. Keep the first version declarative and understandable rather than adding a scripting language.

### Rule-based Info Card templates

- Add reusable Info Card templates that users can name, describe, preview, and apply to multiple Variable Links.
- Allow 1.3 Autolink profiles and `variablelink_template` note properties to select custom templates after those templates become available.
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
- Allow rules to match variable type, variable name, the source scope already defined by a 1.3 Autolink profile, linked property name, file link presence, note tags, and selected frontmatter properties or values.
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
