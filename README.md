# Live Columns

An Obsidian plugin that lets you create **editable columns** directly in your notes.

## Features

- 🔲 Create 2-6 column layouts with commands
- ✏️ **Live editing** - type directly in columns in Live Preview mode
- 🎨 **Customizable colors** - background and border colors per column
- 🔄 Automatic sync between columns and markdown source
- ⌨️ Tab navigation between columns
- 📱 Responsive design for mobile

## Quick Start

### Using Commands (Recommended)

1. Open Command Palette (`Ctrl/Cmd + P`)
2. Search for "Insert columns"
3. Choose 2, 3, or 4 columns

**Keyboard shortcuts:**
- `Ctrl/Cmd + Shift + 2` → Insert 2 columns
- `Ctrl/Cmd + Shift + 3` → Insert 3 columns
- `Ctrl/Cmd + Shift + 4` → Insert 4 columns

### Syntax

```markdown
%% columns:start 2 %%
%% columns:colors green| %%
%% columns:borders purple| %%
Column 1 content
--- col ---
Column 2 content
%% columns:end %%
```

### Changing Colors

1. Click the plugin icon in the ribbon
2. Select "Change background color..." or "Change border color..."
3. Click on the column you want to change
4. Pick a color from the palette

## Commands

| Command | Description |
|---------|-------------|
| `Insert 2 columns` | Create a 2-column layout |
| `Insert 3 columns` | Create a 3-column layout |
| `Insert 4 columns` | Create a 4-column layout |
| `Change column color...` | Change background color |
| `Change column border...` | Change border color |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + Shift + 2/3/4` | Insert columns |
| `Tab` | Move to next column |
| `Shift + Tab` | Move to previous column |

## Installation

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from releases
2. Create folder: `YOUR_VAULT/.obsidian/plugins/live-columns/`
3. Copy the 3 files into this folder
4. Restart Obsidian
5. Enable in Settings → Community Plugins

## Development

```bash
npm install
npm run dev   # watch mode
npm run build # production
```

## License

MIT
