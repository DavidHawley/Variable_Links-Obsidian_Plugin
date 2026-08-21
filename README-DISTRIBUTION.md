# Variable Links 1.0.0

Variable Links is an Obsidian plugin that displays frontmatter properties from other notes through reusable `{{variable}}` tokens.

## AI development disclosure

This plugin was made almost completely with AI-generated code and documentation, guided, tested, and iteratively reviewed through human direction and feedback.

## Installation

1. Extract this archive.
2. Copy the extracted files into your vault at `.obsidian/plugins/variable-links/`.
3. In Obsidian, open **Settings → Community plugins**.
4. Enable **Variable Links**. If it was already enabled, reload Obsidian after replacing the files.

The plugin creates its registry and cache automatically. Installing or upgrading the plugin does not require you to include those generated data files in this distribution.

## Quick start

1. Run **Variable Links: Open Variable Properties** from the Command Palette.
2. Create a Variable Link by choosing a source note and one of its frontmatter properties.
3. Type a token such as `{{customer}}` in a Markdown note.
4. In Reading View and Live Preview, the token displays the current property value.

Typing `{{` opens suggestions for existing links and frontmatter properties found across the vault.

## Main features

- Displays reusable frontmatter values in Reading View and Live Preview.
- Provides an editable Variable Properties and Info Card sidebar.
- Suggests existing links and properties from Markdown files.
- Automatically creates unique links for previously unmapped properties.
- Supports editable Info Cards, custom field labels, and fields from other notes.
- Tracks links with stable GUIDs and safely updates tokens throughout the vault when a link is renamed.
- Supports favorite links and right-click insertion menus.
- Creates a hidden JSON registry automatically on first load.

## Right-click menu

In Source Mode or Live Preview, right-click in the editor and open **Variable Links**:

- **Properties** opens the clicked token in the Variable Properties panel.
- **Favorite** or **Unfavorite** changes the clicked link's favorite status.
- **Insert Favorite** inserts a selected favorite link.
- **Insert** inserts any configured link.

Properties is disabled when the right-click is not on a token. Favorite is disabled unless the clicked token has a configured link. Insert actions use the original right-click position.

## Plugin data

By default, the plugin stores its generated data here:

```text
.obsidian/plugins/variable-links/registry.json
.obsidian/plugins/variable-links/token-cache.json
```

The registry is the source of truth and contains link definitions, stable GUIDs, favorite status, and Info Card settings. The token cache is derived and can be rebuilt automatically.

When upgrading, replace only the distributed plugin files. Do not delete `registry.json` if it contains links you want to keep.

## Included files

- `manifest.json` — Obsidian plugin metadata.
- `main.js` — compiled plugin code.
- `styles.css` — plugin styling.
- `README.md` — this installation and usage guide.
- `LICENSE` — the MIT open-source license.

## License

Variable Links is fully open-source software distributed under the MIT License. See `LICENSE` for the complete terms.

## Version

Variable Links 1.0.0
