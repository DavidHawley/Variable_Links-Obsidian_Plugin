# Variable Links 1.0.0

Variable Links 1.0.0 is the first stable packaged release of the plugin.

## AI development disclosure

Variable Links was made almost completely with AI-generated code and documentation, guided, tested, and iteratively reviewed through human direction and feedback.

## Highlights

- Reusable `{{variable}}` tokens backed by frontmatter properties in other notes.
- Resolved values in Reading View and Live Preview.
- Suggestions for existing Variable Links and frontmatter properties across the vault.
- Automatic creation of uniquely named links for unmapped properties.
- Editable Variable Properties and Info Card sidebar with independently scrollable sections.
- Custom Info Card titles, notes, labels, bordered field tables, and cross-file fields.
- Hidden JSON registry created automatically on first load.
- Stable GUIDs and a derived token cache for verified vault-wide token renames.
- Favorite links with panel and context-menu controls.
- **Insert Favorite** and **Insert** context submenus.
- Automatic refresh of already-open Reading View and Live Preview panes.

## Installation

1. Download `variable-links-1.0.0.zip`.
2. Extract its contents into `.obsidian/plugins/variable-links/` inside your vault.
3. Reload Obsidian.
4. Enable **Variable Links** under **Settings → Community plugins**.

## Upgrading

Replace `manifest.json`, `main.js`, and `styles.css` with the files from the archive, then reload Obsidian. Your generated `registry.json` and `token-cache.json` are not included in the archive and are not overwritten by the upgrade.

## Release contents

- `manifest.json`
- `main.js`
- `styles.css`
- `README.md`
- `LICENSE`

## Notes

- The Variable Links context submenu is available in Source Mode and Live Preview through Obsidian's editor context menu.
- Tokens inside inline code and fenced code blocks are not changed during a rename.
- The token cache is derived data. The plugin rebuilds it when necessary.

## License

Variable Links is fully open-source software released under the MIT License. The complete license is included with every packaged release.
