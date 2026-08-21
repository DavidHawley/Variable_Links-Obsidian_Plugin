Variable Links — Obsidian plugin (scaffold)

This plugin provides global variable-like links that resolve to frontmatter properties in other files.

Current status: scaffolded. Implemented:
- settings UI (choose registry file, toggles)
- registry parser (reads frontmatter from registry file and caches variable definitions)

Next steps:
- implement resolver to read property values from source files
- implement markdown post-processor to render {{variable}} tokens in Reading View
- implement EditorSuggest for "{{" autocompletion
- implement info cards

Registry file schema (frontmatter):

---
variable-links:
  customer:
    file: "[[People/John Smith]]"
    property: "company"
    display: "John Smith"
    card:
      title: "John Smith"
      note: "Primary contact for Acme."
      fields:
        - email
        - phone
---

To build (after installing devDeps):
  npm install
  npm run build

