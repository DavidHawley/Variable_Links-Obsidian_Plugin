# Variable Links

Variable Links is an Obsidian plugin for creating reusable pointers to values in your vault.

A Variable Link can display a value you enter directly or the current value of a property in another note. Insert the same variable anywhere in your vault, then update its source once instead of finding and replacing every copy.

```markdown
Project owner: {{project_owner}}
```

Variable Links can also open a related file when clicked and show a customizable Info Card when hovered.

## Features

- Create reusable variables backed by a fixed value or a note property.
- Display variables in Reading View and Live Preview.
- Open a chosen note when a displayed variable is clicked.
- Rename a variable and update its tokens throughout the vault.
- Insert variables from suggestions, favorites, commands, or the right-click menu.
- Switch an existing token to a different variable from the right-click menu.
- Style displayed values with bold, italic, underline, highlight, color, and opacity controls.
- Build hover Info Cards with notes, properties, tables, dividers, links, and grouped sections.
- Arrange Info Cards with responsive Stack or Grid layouts.

## Quick start

Open the Command Palette and run **Variable Links: Open Variable Properties**. Choose or create a variable, then select one of the two value types:

- **Fixed value** — enter the value directly. You may also choose a file for the variable to open.
- **Property value** — link to a property using `[[File path]]#property`. The displayed value follows the property in that note.

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

- Choose an existing variable to insert its token.
- Choose an unlinked property to create a new variable and insert it.
- Mark commonly used variables as favorites for quicker access.

You can also right-click in the Markdown editor and open the **Variable Links** submenu to:

- Open a variable in the Properties panel.
- Favorite or unfavorite the selected variable.
- Insert a favorite or any configured variable.
- Switch a complete token to another variable.

Insert actions are disabled while the cursor is already inside a Variable Link token.

## Variable Properties panel

The panel has two tabs beneath the **Variable Link Properties** heading.

### Link

Use the Link tab to manage:

- Variable name and favorite status.
- Fixed value or Property value type.
- Property link and its current linked value.
- File link opened when the variable is clicked.
- Display name.
- Bold, italic, decoration, color, and opacity.

Supported linked text, number, and true/false property values can be edited directly from the panel. Changing a variable's type requires confirmation, and its saved information is retained if you switch back later.

When you rename a variable, known tokens in Markdown notes are updated automatically. Tokens inside inline code and fenced code blocks are left unchanged.

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

The Card Designer also includes:

- Classic stack, Compact grid, and Profile card starter layouts.
- Drag-and-drop and arrow controls for arranging items.
- Editable item names and collapsible sections for organizing complex cards.
- A live preview and up to 50 Undo steps.
- Restore original and Restore defaults actions.
- Right-click **Copy appearance** and **Paste appearance** actions that copy styling without replacing content.

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

## Hover behavior

Info Cards work in Reading View and Live Preview. Their hover delays are configured separately in the plugin settings, and Live Preview cards can be disabled globally or for an individual variable.

Cards open near the pointer, stay within the visible Obsidian window, and close when the pointer leaves or focus moves elsewhere.

## Appearance defaults

Plugin settings provide a default appearance for displayed variables, including bold, italic, underline or highlight, color, and opacity. Individual variables can override these defaults or return to them later.

Six reusable color swatches are available in the appearance controls. Colors support opacity while still following Obsidian's current theme when no custom color is selected.

## Live Preview editing

In Live Preview, a Variable Link normally displays its resolved value. Move the caret into it to reveal and edit the original token:

```text
{{customer}}
```

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
