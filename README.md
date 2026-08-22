# Variable Links

Variable Links is an Obsidian plugin for creating reusable pointers to properties in your notes.

A token such as `{{customer}}` can point to a property in another note. Wherever the token appears, it displays the property's current value. Change the source property once, and every use of the variable reflects the new value.

## Main features

- Create named pointers to properties in your notes.
- Display the current property value in Reading View and Live Preview.
- Link a variable to any note in your vault.
- Show customizable Info Cards when hovering over variables.
- Set variable values to bold, italic, underlined, highlighted, or undecorated with an optional custom color and opacity.
- Access variables and actions from the editor’s right-click menu.
- Rename variables while automatically updating their tokens throughout the vault.
- Mark frequently used variables as favorites.
- Insert variables using suggestions after typing `{{`.

## AI development disclosure

Variable Links was made almost entirely with AI-generated code and documentation, guided, tested, and reviewed through human direction and feedback.

## Getting started

Suppose `People/John Smith.md` contains:

```yaml
---
company: Acme Corporation
email: john@example.com
phone: 555-0100
---
```

Create a Variable Link named `customer` that points to the `company` property in this note.

You can then write:

```markdown
Customer: {{customer}}
```

The displayed result will be:

```text
Customer: Acme Corporation
```

If the `company` property changes, the displayed value updates without requiring you to replace the token.

## Creating and inserting variables

Type `{{` in the editor to open suggestions.

The suggestion menu includes:

- Existing Variable Links.
- Frontmatter properties found in notes across your vault.

Selecting an existing variable inserts its token. Selecting an unlinked property creates a new Variable Link and inserts it automatically.

Generated variable names use a unique number when needed, such as:

```text
{{Due_01}}
{{Due_02}}
```

## Variable Properties panel

Open the Command Palette and run:

**Variable Links: Open Variable Properties**

The panel lets you manage:

- Variable name
- Property link, such as `[[People/John Smith]]#company`
- File link opened when the variable is clicked
- Display name
- Favorite status
- Default appearance
- Info Card settings

Use the **Link** and **Card** tabs beneath the **Variable Link Properties** header to switch between mapping and Info Card settings.

Set a default variable appearance in the plugin settings, including bold, italic, decoration, and color. Individual variables can override that appearance or return to the current defaults. A reusable six-color palette makes saved colors available from every variable’s appearance controls.

If your cursor is inside an unknown token, such as `{{new_variable}}`, opening the panel creates a prefilled form for setting it up.

## Right-click menu

Right-click in the Markdown editor to open the **Variable Links** submenu.

Available actions include:

- **Properties** — open the selected variable in the Variable Properties panel.
- **Favorite / Unfavorite** — change whether the variable appears in your favorites.
- **Insert Favorite** — insert one of your favorite variables.
- **Insert** — browse and insert any configured variable.

Variables are inserted at the position where you opened the context menu.

## Renaming variables

You can rename a variable from the Variable Properties panel.

For example, renaming:

```text
{{customer}}
```

to:

```text
{{client}}
```

updates that variable’s known tokens throughout your Markdown notes. The link keeps its internal identity, property link, file link, and Info Card configuration.

Tokens inside inline code and fenced code blocks are left unchanged.

## Info Cards

Info Cards display additional information when you hover over a variable in Reading View or Live Preview. The Live Preview delay defaults to three seconds and can be changed in the plugin settings. Live Preview hover can also be disabled globally or for individual cards without affecting Reading View.

A card can include:

- A custom title
- A Markdown note or description
- Properties from the variable’s source note
- Properties from other notes
- Custom labels
- A link to the source note

### Source-note fields

Enter a property name:

```text
email
```

### Custom labels

Use `property:Label`:

```text
email:Email Address
phone:Phone Number
```

### Fields from another note

Use `[[Note]]#property`:

```text
[[Projects/Launch Plan]]#due
```

You can also provide a custom label:

```text
[[Projects/Launch Plan]]#due:Project Due Date
```

The field editor suggests properties found across your vault.

## Live Preview

Variable Links display their current values in Live Preview. Move the cursor into a variable to reveal and edit its original token:

```text
{{customer}}
```

## Installation

Copy the following files into:

```text
.obsidian/plugins/variable-links/
```

Required files:

- `main.js`
- `manifest.json`
- `styles.css`

Reload Obsidian, then enable **Variable Links** under **Settings → Community plugins**.

## License

Variable Links is open-source software released under the [MIT License](LICENSE).
