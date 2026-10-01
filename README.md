# Variable Links

Variable Links is an Obsidian plugin for creating reusable pointers to values in your vault.

A Variable Link can display a value you enter directly or the current value of a property in another note. Insert the same variable anywhere, then update its source once instead of finding and replacing every copy.

```markdown
Project owner: {{project_owner}}
```

Variable Links can also open a related note when clicked and show a customizable Info Card when hovered.

## Features

- Create reusable variables backed by fixed text or a note property.
- Insert variables from editor suggestions, favorites, commands, or context menus.
- Search suggestions using parts of a variable name, file, property, or resolved value.
- Capture the current date or time as a named Variable Link.
- Change the displayed letter case for one token without changing its saved value.
- Open a chosen note when a displayed variable is clicked.
- Rename variables and update their known tokens throughout the vault.
- Style displayed values with bold, italic, underline, highlight, color, and opacity controls.
- Build hover Info Cards with notes, properties, tables, dividers, links, and grouped sections.
- Generate and maintain Variable Links for files or folders with Autolink profiles.
- Search, sort, rename, or delete Variable Links from a workspace Management Center.
- Customize the characters used around Variable Link tokens.
- Calculate stored or inline expressions, including values from the current note's properties.
- Add or subtract calendar durations from canonical date/time values.
- Quickly edit values or source mappings with Alt/Option-click, or open a compact inspector with Shift+Alt/Option-click.

## Calculations and date arithmetic

Create a **Computed value** in Variable Properties, enter an expression such as `round(@price * @qty * (1 + var("tax")), 2)`, then reference its permanent name with `{{total}}`. Registered dependencies follow their stable IDs when their names change. Supported functions include `abs`, `round`, `floor`, `ceil`, `min`, `max`, `sum`, `average`, `clamp`, `sqrt`, and `pow`. Values must be numbers or strictly numeric text. Invalid calculations display `[Expression error]`; the token hover text and editor preview explain the cause.

For a calculation directly in a note, start the token with `=`:

```markdown
{{=round(@price * @qty * (1 + @tax), 2)}}
```

Inline references use an existing Variable Link first, followed by an enabled shortcut, then an exact frontmatter property in the note containing the expression. No permanent entries are created during rendering. The inline quick editor provides a preview and suggests an unused permanent name such as `math_01` when the name field is blank. You can change the name; **Review permanent creation** lists the property links that would be added, and nothing is created until you explicitly confirm with **Create reviewed variable and property links**. Right-click an inline expression and choose **Make into variable link** to open this flow in editing mode or Reading View. If identical expressions share a rendered section in Reading View, choose the source line and column to convert. Saving the inline expression alone does not create permanent entries. Renaming registered inputs updates their references in valid inline expressions. Code blocks and inline code remain literal.

Choose **Date**, **Time**, or **Date and time** in the variable's Date/time field. Fixed values store their canonical value separately from their display format. Note-property dates read ISO text from the source property. Use `YYYY-MM-DD`, `HH:mm[:ss]`, or `YYYY-MM-DDTHH:mm[:ss]` as the canonical input; Date-time also accepts an explicit ISO offset. New captured date/time variables retain their canonical values automatically. Older captured text remains usable; select its date/time kind and enter a canonical value to enable arithmetic.

```markdown
{{deadline::add(2M,3d,2h,15m)}}
{{deadline::sub(1w)}}
{{deadline::sub(3M5m)}}
```

Units are case-sensitive: `y` years, `M` months, `w` weeks, `d` days, `h` hours, `m` minutes, and `s` seconds. Duration amounts are signed whole numbers. Compact `3M5m` and comma-separated `3M,5m` both mean three months and five minutes; you can also mix the forms or separate amounts with spaces. A sign belongs to its individual amount: `-3M5m` means minus three months plus five minutes, while `sub(3M5m)` subtracts both. Each operation combines repeated units and applies years, then months, then weeks/days, then elapsed hours/minutes/seconds. Years and months clamp to the last valid day of the target month. Calendar operations use the device's local time and preserve the clock time; nonexistent times at daylight-saving transitions produce an error. Repeated local times choose the earlier occurrence. Hours/minutes/seconds measure elapsed time. Time-only inputs use January 1, 2000 as their calendar anchor. Month clamping means addition and subtraction are not always exact inverses.

## Quick editing

**Alt-click** on Windows/Linux or **Option-click** on macOS opens a small value editor. Add **Shift** to open the compact inspector for the name, display name, source mapping, value or expression, Favorite, and click-through link. For a note property, choose **Source property value** to update the note itself or **Variable definition / source mapping** to change which property the Variable Link reads. Saving a definition affects all uses of that variable; saving a source value affects every reference to that note property.

Enter saves single-line fields; Ctrl/Cmd+Enter saves a multiline value or expression. Escape or Cancel discards the draft. Editors reject stale saves if the definition or source property changed while editing. List values use JSON; the full editor handles structural fixed-list changes, stable keys, type changes, appearance, and Info Cards. Inline expression editing is available in editing mode.

The same actions are available through context menus and the **Quick-edit variable at cursor** and **Open compact inspector for variable at cursor** commands, which accept user-assigned hotkeys. These also provide access when a Linux window manager intercepts Alt-click. In Management Center, the pencil opens the compact inspector, the text-cursor button edits Display name inline, and Favorite is directly editable. **Edit selected** previews changes to Favorite, hidden rendering, or click-through links for all selected entries, including selections hidden by filters.

## Quick start

Open the Command Palette and run **Variable Links: Open Variable Properties**. Choose or create a variable, then select its value source and shape:

- **Fixed value** — enter the displayed value directly. You may also choose a file for the variable to open.
- **Property value** — link to a property using `[[File path]]#property`. The displayed value follows the property in that note.
- **Computed value** — enter a safe expression that calculates a value from other Variable Links.
- Choose a Fixed list or Note property list when the source contains multiple items; stable keys let tokens select named items across reordering.

For example, if `People/John Smith.md` contains:

```yaml
---
company: Acme Corporation
---
```

Create a Property value variable named `customer` and set its Property link to:

```text
[[People/John Smith]]#company
```

Then insert:

```markdown
Customer: {{customer}}
```

The displayed result is `Customer: Acme Corporation`. If the property changes, the displayed variable changes with it.

## Creating and inserting variables

Type `{{` in the editor to open suggestions. The list includes existing Variable Links and properties found across your vault.

- Enter multiple search terms to narrow results across variable names, display names, files, and properties. For example, enter a few letters from a filename followed by part of a property name.
- Begin the search with `*` to find existing variables by their current displayed value.
- Choose an existing variable to insert it.
- Choose a note property to create a new property-backed variable and insert it. Properties already linked elsewhere remain available but appear lower in the results.
- Press Tab or Enter to complete a supported creation expression.

You can create named variables directly while typing:

```text
{{Status=FIXED:"In progress"}}
{{Owner=PROPERTY:[[People/John Smith]]#name}}
```

Leaving out the value or property opens the Variable Properties panel with the name already filled in:

```text
{{Status=FIXED}}
{{Owner=PROPERTY}}
```

Variable names in creation expressions cannot contain spaces.

### Capturing a date or time

`DATE`, `TIME`, and `DATETIME` capture the current moment and save it as a normal fixed-value Variable Link. The captured value does not keep changing afterward.

```text
{{DATE}}
{{Started=TIME:hh:mm A}}
{{Published=DATETIME:YYYY-MM-DD HH:mm}}
{{due=DATE::add(7d)}}
{{previous=DATE:YYYY-MM-DD::sub(1M)}}
{{reminder=DATETIME:YYYY-MM-DD HH:mm::add(1w)::sub(2h)}}
{{ad = DATETIME::sub(3M5m)}}
```

An unnamed shortcut creates a name from the first five letters or numbers of the current filename, the shortcut type, and a counter, such as `Proje_Date_01`. Optional `::add()` and `::sub()` steps adjust the captured date/time before saving it; the adjusted value stays fixed, rather than keeping an offset selector on the inserted token. Put a custom display format before the adjustment steps. Use `[::]` or escaped colons for literal double colons in a format. Invalid durations leave the creation expression unchanged and show an error.

All three shortcuts support the same date-and-time format language; they differ only in their default formats and automatic names. Open the **Syntax** Settings tab and select the question-mark help beside the formats for a complete token reference and live preview.

### Changing the displayed text case

Add a matching marker around a variable name to change only that token's displayed capitalization:

```text
{{.customer.}}       Lowercase first letter
{{..customer..}}     lowercase all
{{'customer'}}       Uppercase first letter
{{''customer''}}     Capitalize each word
{{'''customer'''}}   UPPERCASE ALL
```

The same choices are available from the token context menu, and each variable can have a saved default text case in the Variable Properties panel.

### Context menu

Right-click in the Markdown editor and open the **Variable Links** submenu to:

- Open a variable in the Properties panel.
- Favorite or unfavorite the selected variable.
- Insert a favorite or any configured variable.
- Switch a complete token to another variable.
- Change the displayed text case for a token.
- Copy selected Markdown, or one right-clicked token, with resolved values and portable formatting.

Insert actions are disabled while the cursor is already inside a Variable Link token.

## Variable Properties panel

The panel has **Link** and **Card** tabs beneath the **Variable Link Properties** heading.

The Management Center's settings button opens this same detailed editor beside the list, including the shared type-change confirmation, property suggestions, appearance controls, and Card editor. Managed entries show their Autolink profile and managed fields.

Unsaved properties, simple Card fields, and linked-value drafts remain in place during background refreshes. Save or use **Cancel edits** before selecting another variable. Cancel edits discards the current variable's unsaved properties and simple Card fields; the Card Designer has its own Save and Cancel. Saves reject changed registry entries instead of overwriting newer settings.

### Link

Use the Link tab to manage:

- Variable name and favorite status.
- Fixed value or Property value type.
- Property link and its current linked value.
- File link opened when the variable is clicked.
- Whether click-through links are enabled.
- Display name and default text case.
- Bold, italic, decoration, color, and opacity.

Supported text, number, and true/false property values can be edited directly from the panel. Changing a variable's type requires confirmation, and its saved information is retained if you switch back later.

When you rename a variable, known tokens in Markdown notes are updated automatically. Tokens inside inline code, fenced code blocks, and other non-prose Markdown remain raw and are not rendered as values.

### Card

Use the Card tab to configure the Info Card shown when the variable is hovered. You can keep the original simple card fields or enable **Use block layout editor** for the Card Designer.

## Info Cards

The original editor provides a straightforward title, note, field list, and source link. The Card Designer supports more detailed layouts made from:

- Titles
- Notes with Markdown
- Individual properties
- Multi-column property tables
- Dividers
- Source links
- Stack containers that group related items

Cards can use a vertical Stack layout or a responsive Grid with one to four columns. You can adjust spacing, maximum width, padding, corner radius, border, shadow, background, alignment, and optional CSS classes.

The Card Designer also includes starter layouts, drag-and-drop and arrow controls, editable item names, collapsible sections, a live preview, Undo history, restore actions, and appearance copy-and-paste between compatible items.

Stack containers can arrange their contents vertically or horizontally. They may contain normal card items, but not another Stack container.

### Referencing properties in cards

Use a property name to read from the variable's source note:

```text
email
```

Add `:Display name` to provide a custom label:

```text
email:Email address
```

Reference a property in another note with:

```text
[[Projects/Launch Plan]]#due
```

You can also add a custom label:

```text
[[Projects/Launch Plan]]#due:Project due date
```

## Autolink profiles

Autolink profiles create and maintain property-backed Variable Links for one file or every matching note in a folder. Configure them under **Settings → Variable Links → Autolink**.

Each profile can define:

- An exact file or folder scope, with optional subfolders.
- The property whose value should be displayed.
- A naming pattern for generated Variable Links.
- An optional file-link property and Card field list.
- A starter Info Card layout.
- Whether matching notes may override the profile through frontmatter properties.

Preview a profile before applying it. **Apply safe changes** creates non-conflicting links and safely refreshes fields still managed by the profile. Replacing an existing same-name Variable Link requires separately enabling overwrite and confirming **Apply all**.

When a profile's Card-property list changes, you can separately update property references in existing Cards without renaming their Variable Links or replacing the rest of each Card design.

Deleting a profile does not delete Variable Links it previously created.

### Naming patterns

Autolink profiles and mass rename share a flexible naming-pattern format. Select the question-mark help beside a Name pattern field for the complete reference.

Common placeholders include:

```text
{filename}     Source filename
{path}         Source path without .md
{folder}       Source folder
{property}     Linked property name
{property:ID}  Value of the ID property
{profile}      Autolink profile name
##             Zero-padded counter: 01, 02, 03
```

Patterns can also select or reorder words and characters, count backward from the end, and replace literal text.

## Management Center

Open the **Variable links management center** from the left ribbon or Command Palette. It opens as a normal Obsidian workspace tab.

Use it to:

- Search and sort the registry.
- Filter by variable type, ownership, or Autolink profile.
- Open one variable's settings or delete it.
- Select a range with Shift-click.
- Delete selected variables, optionally replacing their tokens with the current displayed values.
- Preview and apply mass renames using a prefix, suffix, find-and-replace, or naming pattern.
- Reapply an Autolink profile's current naming pattern to its managed variables.
- Limit the visible list to 20, 50, 100, 250, or all entries.

Rename and delete actions show a confirmation preview before changing the registry or notes.

## Hover and appearance

Info Cards work in Reading View and Live Preview. Their hover delays are configured separately in the **Cards** Settings tab, and Live Preview cards can be disabled globally or for an individual variable.

Cards open near the pointer, stay within the visible Obsidian window, and close when the pointer leaves or focus moves elsewhere.

The **Appearance** Settings tab provides defaults for displayed variables, including bold, italic, underline or highlight, color, and opacity. Individual variables can inherit these defaults or keep their own appearance. Six reusable color swatches are available, and colors support opacity.

## Token format and migration

The **Syntax** Settings tab lets you replace the default `{{` prefix and `}}` suffix if they conflict with another plugin or writing format. Variable Links keeps recognized older formats available unless you explicitly stop recognizing them.

When changing the active format, you can use it only for new tokens or preview and migrate verified existing tokens. Test custom characters carefully because some combinations overlap Markdown or Obsidian syntax.

## Live Preview editing

In Live Preview, a Variable Link normally displays its resolved value. Move the caret into it to reveal and edit the original token:

```text
{{customer}}
```

## Settings

Variable Links settings are organized into five tabs:

- **General** — registry and cache tools.
- **Syntax** — token characters, captured date/time formats, and migration.
- **Appearance** — default text styling and reusable colors.
- **Cards** — Info Card behavior and hover timing.
- **Autolink** — profile creation, previews, and synchronization.

Question-mark buttons open focused help for options that need more explanation.

## Installation

Download `main.js`, `manifest.json`, and `styles.css` from the matching version on the [Releases page](https://github.com/DavidHawley/Variable_Links-Obsidian_Plugin/releases).

Copy the files into:

```text
.obsidian/plugins/variable-links/
```

Reload Obsidian, then enable **Variable Links** under **Settings → Community plugins**.

## AI development disclosure

Variable Links was made almost entirely with AI-generated code and documentation, guided, tested, and reviewed through human direction and feedback.

## License

Variable Links is open-source software released under the [MIT License](LICENSE).
