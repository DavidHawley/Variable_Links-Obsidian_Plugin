# Variable Links

Variable Links is an Obsidian plugin for displaying frontmatter properties from other notes as reusable variables.

Write a token such as `{{customer}}` in any note. The plugin looks up `customer` in a central registry, reads the configured property from its source note, and displays the current value.

## Features

- Resolves reusable `{{variable}}` tokens from note frontmatter.
- Displays resolved values in Reading View and Live Preview.
- Reveals the original token while its text is selected in Live Preview.
- Suggests existing Variable Links after typing `{{`.
- Suggests frontmatter properties found across the vault.
- Automatically creates a unique Variable Link when an unmapped property suggestion is selected, such as `Due_01`, `Due_02`, and so on.
- Keeps a stable GUID for every Variable Link and updates its tokens throughout the vault when it is renamed.
- Provides an editable Variable Properties sidebar.
- Shows configurable hover Info Cards in Reading View.
- Supports custom field labels and fields from other notes.

## Installation

Copy these files into your vault's `.obsidian/plugins/variable-links/` directory:

- `manifest.json`
- `main.js`
- `styles.css`

Reload Obsidian, then enable **Variable Links** under **Settings → Community plugins**.

## Registry

On first load, the plugin automatically creates a hidden JSON registry at:

```text
.obsidian/plugins/variable-links/registry.json
```

Because it lives inside Obsidian's configuration folder, it does not appear as a note in the vault. If the configured registry is missing, the plugin creates a new empty registry at that location. Existing Markdown, YAML, and JSON registries remain supported and can be selected in the plugin settings.

The default JSON registry uses this structure:

```json
{
  "variable-links": {
    "customer": {
      "guid": "7b4c5882-2a82-4ab2-a920-0f7f2e3eb44f",
      "file": "[[People/John Smith]]",
      "property": "company",
      "display": "John Smith",
      "favorite": true,
      "card": {
        "title": "Customer details",
        "note": "Primary contact for this account.",
        "fields": [
          "email:Email Address",
          "phone:Phone Number",
          "[[Projects/Launch Plan]]#due:Project Due Date"
        ],
        "showSourceLink": true
      }
    }
  }
}
```

Each variable definition supports:

| Setting | Description |
| --- | --- |
| `guid` | Stable internal ID used to track this Variable Link across renames. Generated automatically. |
| `file` | Source note as a vault path or wiki-link. |
| `property` | Frontmatter property whose value the token displays. |
| `display` | Optional descriptive name used in suggestions. |
| `favorite` | Optional favorite status. Favorited links appear in the Insert Favorite context submenu. |
| `card` | Optional Info Card configuration. |

## Using variables

Given the registry example above, write:

```markdown
Customer: {{customer}}
```

In Reading View and Live Preview, the token is replaced with the current value of `company` from `People/John Smith.md`.

In Live Preview, move the caret into the token to reveal and edit its original `{{customer}}` text. Live Preview values are display text rather than navigation links.

## Suggestions

Type `{{` to open suggestions. The menu contains:

- Variable Links already defined in the registry.
- Unmapped frontmatter properties from Markdown notes in the vault.

Selecting an existing variable inserts its token. Selecting an unmapped property creates a registry entry targeting that file and property, then inserts a unique generated token. For example, selecting `Due` creates `{{Due_01}}`; if that name exists, the plugin tries `Due_02`.

Property names containing spaces are converted to underscores in generated token names.

## Variable Properties panel

Run **Variable Links: Open Variable Properties** from the Command Palette.

The panel is split into two independently scrollable sections:

1. **Variable properties** — edit the variable name, source note, property, and display name.
2. **Info card** — edit the card title, Markdown note, fields, and source-link option.

The toolbar at the top of the panel lets you:

- Select any existing Variable Link from the registry.
- Use **Set token** to replace the token currently under the editor caret with the selected Variable Link.
- Use **Delete** to remove the selected registry entry.

In the Markdown editor or Live Preview, the **Variable Links** right-click submenu provides:

- **Properties** — opens the right-clicked token directly in the panel. It is disabled when the right-click is not on a token.
- **Favorite** or **Unfavorite** — changes the saved favorite status of the right-clicked configured link.
- **Insert Favorite** — lists favorite links and inserts the selected token at the original right-click position.
- **Insert** — lists every configured Variable Link alphabetically and inserts the selected token at the original right-click position.

Favorite status can also be changed with the **Favorite** checkbox in the Variable Properties form.

Changing a variable name and saving renames the existing registry entry and replaces that link's tokens in Markdown notes throughout the vault. It does not leave the old entry behind, and it will not overwrite another existing Variable Link with the same name. Tokens inside inline code or fenced code blocks are not changed.

Placing the caret inside an unknown token such as `{{new_variable}}` opens a prefilled setup form for that variable.

## Token cache

The plugin creates a derived cache at:

```text
.obsidian/plugins/variable-links/token-cache.json
```

The cache records each Variable Link's GUID, current token name, and the file, line, and character position of its known occurrences. It is updated when Markdown notes are created, edited, renamed, or deleted. Before a rename changes a note, the plugin reads the current file and verifies the exact old token is still present at a parsed token location.

The cache is an index, not the source of truth. It can be deleted while Obsidian is closed; the plugin rebuilds it from the registry and Markdown notes the next time it loads.

## Info Cards

When Info Cards are enabled, hovering over a rendered variable in Reading View shows its configured card. Saved card changes are read from the registry on each hover, so reopening the note is not required.

### Fields from the variable's source note

Enter a property name by itself:

```text
email
```

Property names are displayed with their first character capitalized.

### Custom field labels

Use `property:Display Name`:

```text
email:Email Address
```

The plugin reads the `email` property but displays **Email Address** in the card table.

### Fields from another note

Use `[[File]]#property`:

```text
[[Projects/Launch Plan]]#due
```

Custom labels also work with cross-file fields:

```text
[[Projects/Launch Plan]]#due:Project Due Date
```

The Fields editor provides property suggestions from Markdown files across the vault. Use Up/Down to navigate, Enter to select, and Escape to close the menu.

Info Card fields are displayed in a full-width bordered table.

## Development

Install dependencies and build:

```powershell
npm install --legacy-peer-deps
npm run build
Copy-Item dist/main.js main.js
Copy-Item src/styles.css styles.css
```

The distributable plugin consists of `manifest.json`, `main.js`, and `styles.css`.
