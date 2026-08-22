# Roadmap

This document records planned improvements to Variable Links. Plans may change as features are designed and tested. Completed work belongs in `CHANGELOG.md`.

## 1.2.0

### Configurable Info Card delays

- Add a separate hover-delay setting for Reading View.
- Default the Reading View delay to 0.5 seconds.
- Let the Live Preview delay increase in 0.25-second increments, starting at 1 second.
- Keep the Live Preview default at 3 seconds.
- Preserve compatible delay values already saved by users.

### Favorite control placement

- Move the Favorite checkbox to the top right of the Link panel, beside the selected Variable Link name and above the mapping editor.
- Save Favorite changes immediately without requiring the mapping form to be saved.
- Keep a Favorite option available while creating a new variable.
- Preserve the current Favorite state when a mapping is edited or renamed.
- Keep the variable name and Favorite control usable when the sidebar is narrow.
