import { Plugin, MarkdownPostProcessorContext, Editor, MarkdownView, Notice, addIcon, Menu, Modal, App } from 'obsidian';
import { liveColumnsExtension } from './liveColumnsExtension';

// Simple two-column icon (generated via scripts/generate_icon.py)
const LIVE_COLUMNS_ICON = `
<svg width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" fill="none">
  <rect x="10" y="18" width="35" height="64" rx="6" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="4"/>
  <rect x="55" y="18" width="35" height="64" rx="6" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="4"/>
</svg>
`;

export default class LiveColumnsPlugin extends Plugin {
    // Flag for column selection mode
    private isSelectingColumn = false;
    private columnClickHandler: ((e: MouseEvent) => void) | null = null;

    onload() {

        // Register custom icon and ribbon
        addIcon('live-columns', LIVE_COLUMNS_ICON);
        const ribbon = this.addRibbonIcon('live-columns', 'Insert columns / colors', (evt) => {
            const menu = new Menu();
            menu.addItem((item) =>
                item.setTitle('Insert 2 columns').setIcon('columns').onClick(() => this.insertColumnsAtActive(2))
            );
            menu.addItem((item) =>
                item.setTitle('Insert 3 columns').setIcon('columns').onClick(() => this.insertColumnsAtActive(3))
            );
            menu.addItem((item) =>
                item.setTitle('Insert 1 column (full width)').setIcon('columns').onClick(() => this.insertColumnsAtActive(1))
            );
            menu.addSeparator();
            menu.addItem((item) =>
                item.setTitle('Change background color...').setIcon('palette').onClick(() => this.enterColumnSelectionMode('color'))
            );
            menu.addItem((item) =>
                item.setTitle('Change border color...').setIcon('square').onClick(() => this.enterColumnSelectionMode('border'))
            );
            // @ts-ignore showAtMouseEvent exists
            menu.showAtMouseEvent(evt as MouseEvent);
        });
        ribbon.addClass('live-columns-ribbon');

        // Register markdown post-processor for Reading mode (marker-based)
        this.registerMarkdownPostProcessor(this.columnsPostProcessor.bind(this));
        // Register CodeMirror 6 extension for Live Preview (marker-based, safe)
        this.registerEditorExtension(liveColumnsExtension());

        // Register commands for inserting columns
        this.registerCommands();
    }

    onunload() {
        this.exitColumnSelectionMode();
    }

    /**
     * Enter column selection mode - wait for user to click on a column
     */
    private enterColumnSelectionMode(type: 'color' | 'border' = 'color') {
        if (this.isSelectingColumn) {
            this.exitColumnSelectionMode();
            return;
        }

        this.isSelectingColumn = true;
        const msg = type === 'color' ? 'background' : 'border';
        new Notice(`👆 Click on a column to change its ${msg} color...`, 5000);

        // Add visual indicator class to body
        document.body.classList.add('live-columns-selecting');

        // Create click handler
        this.columnClickHandler = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const column = target.closest('.live-column');
            const container = target.closest('.live-columns-container');

            if (column && container) {
                e.preventDefault();
                e.stopPropagation();

                const columnIndex = parseInt(column.getAttribute('data-column-index') || '0', 10);

                // Find which block this is (count containers before this one)
                const allContainers = document.querySelectorAll('.live-columns-container');
                let blockIndex = 0;
                for (let i = 0; i < allContainers.length; i++) {
                    if (allContainers[i] === container) {
                        blockIndex = i;
                        break;
                    }
                }

                this.exitColumnSelectionMode();
                this.showColorPaletteForColumn(columnIndex, type, blockIndex);
            }
        };

        // Listen for clicks on columns
        document.addEventListener('click', this.columnClickHandler, true);

        // Auto-exit after 10 seconds
        setTimeout(() => {
            if (this.isSelectingColumn) {
                this.exitColumnSelectionMode();
                new Notice('Column selection cancelled.');
            }
        }, 10000);
    }

    /**
     * Exit column selection mode
     */
    private exitColumnSelectionMode() {
        this.isSelectingColumn = false;
        document.body.classList.remove('live-columns-selecting');

        if (this.columnClickHandler) {
            document.removeEventListener('click', this.columnClickHandler, true);
            this.columnClickHandler = null;
        }
    }

    /**
     * Show color palette after user selected a column
     */
    private showColorPaletteForColumn(columnIndex: number, type: 'color' | 'border', blockIndex: number = 0) {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const editor = view?.editor;
        if (!editor) {
            new Notice('Editor not found.');
            return;
        }

        const doc = editor.getValue();
        const startRe = /%%\s*columns:start\s+(\d+)\s*%%/g;

        // Find the Nth block (0-indexed)
        let startMatch: RegExpExecArray | null = null;
        let matchCount = 0;
        while ((startMatch = startRe.exec(doc)) !== null) {
            if (matchCount === blockIndex) {
                break;
            }
            matchCount++;
        }

        if (!startMatch) {
            new Notice('Không tìm thấy block columns.');
            return;
        }

        const num = parseInt(startMatch[1], 10);
        if (isNaN(num) || num < 1) {
            new Notice('Invalid columns block.');
            return;
        }

        if (columnIndex >= num) {
            new Notice(`Block only has ${num} columns, you selected column ${columnIndex + 1}.`);
            return;
        }

        const startPos = startMatch.index;
        const endRe = /%%\s*columns:end\s*%%/g;
        endRe.lastIndex = startRe.lastIndex;
        const endMatch = endRe.exec(doc);

        if (!endMatch) {
            new Notice('Columns block missing end marker.');
            return;
        }
        const endPos = endMatch.index + endMatch[0].length;

        const blockText = doc.slice(startPos, endPos);
        const blockLines = blockText.split(/\r?\n/);
        const colorLineRe = /^%%\s*columns:colors\s+([^\n%]+)\s*%{1,2}\s*$/i;
        const borderLineRe = /^%%\s*columns:borders\s+([^\n%]+)\s*%{1,2}\s*$/i;
        let colors: string[] = [];
        let borders: string[] = [];

        // Parse existing colors and borders
        for (let i = 1; i < blockLines.length - 1; i++) {
            const line = blockLines[i].trim();
            if (!line) {
                continue;
            }

            const colorMatch = line.match(colorLineRe);
            if (colorMatch) {
                colors = colorMatch[1].split('|').map(c => c.trim());
                continue;
            }

            const borderMatch = line.match(borderLineRe);
            if (borderMatch) {
                borders = borderMatch[1].split('|').map(c => c.trim());
                continue;
            }

            break;
        }

        // Ensure arrays have the right length
        while (colors.length < num) colors.push('');
        while (borders.length < num) borders.push('');

        const typeName = type === 'color' ? 'background' : 'border';

        // Extended color palette
        const palette: { name: string; token: string; color: string }[] = [
            // Row 1 - Basics
            { name: 'Default', token: '', color: '#ffffff' },
            { name: 'Light Gray', token: 'lightgray', color: '#d1d5db' },
            { name: 'Gray', token: 'gray', color: '#6b7280' },
            { name: 'Dark Gray', token: 'darkgray', color: '#374151' },
            // Row 2 - Blues
            { name: 'Light Blue', token: 'lightblue', color: '#93c5fd' },
            { name: 'Blue', token: 'blue', color: '#3b82f6' },
            { name: 'Dark Blue', token: 'darkblue', color: '#1e40af' },
            { name: 'Indigo', token: 'indigo', color: '#6366f1' },
            // Row 3 - Greens
            { name: 'Light Green', token: 'lightgreen', color: '#86efac' },
            { name: 'Green', token: 'green', color: '#22c55e' },
            { name: 'Dark Green', token: 'darkgreen', color: '#15803d' },
            { name: 'Teal', token: 'teal', color: '#14b8a6' },
            // Row 4 - Warm colors
            { name: 'Yellow', token: 'yellow', color: '#fbbf24' },
            { name: 'Orange', token: 'orange', color: '#f97316' },
            { name: 'Red', token: 'red', color: '#ef4444' },
            { name: 'Pink', token: 'pink', color: '#ec4899' },
            // Row 5 - Purples
            { name: 'Light Purple', token: 'lightpurple', color: '#c4b5fd' },
            { name: 'Purple', token: 'purple', color: '#a855f7' },
            { name: 'Dark Purple', token: 'darkpurple', color: '#7c3aed' },
            { name: 'Fuchsia', token: 'fuchsia', color: '#d946ef' },
        ];

        // Create and show color picker modal
        const modal = new ColorPickerModal(this.app, palette, typeName, (selectedToken: string, selectedName: string) => {
            if (type === 'color') {
                colors[columnIndex] = selectedToken;
            } else {
                borders[columnIndex] = selectedToken;
            }
            this.applyColumnStyles(editor, startPos, endPos, num, colors, borders, doc);
            new Notice(`Set column ${columnIndex + 1} ${typeName}: ${selectedName}`);
        });
        modal.open();
    }

    /**
     * Apply styles (colors/borders) to the columns block
     * FIXED: Now properly preserves both colors and borders
     */
    private applyColumnStyles(
        editor: Editor,
        startPos: number,
        endPos: number,
        numColumns: number,
        colors: string[],
        borders: string[],
        doc: string
    ) {
        const blockText = doc.slice(startPos, endPos);
        let newBlock = blockText;

        // Helper to update or insert a metadata line
        const updateLine = (prefix: string, items: string[], text: string) => {
            const lineContent = `%% ${prefix} ${items.slice(0, numColumns).join('|')} %%`;
            const re = new RegExp(`%%\\s*${prefix.replace(':', '\\:')}\\s+[^\\n%]+\\s*%%`);

            if (re.test(text)) {
                return text.replace(re, lineContent);
            } else {
                // Insert after start marker
                const startRe = /%%\s*columns:start\s+(\d+)\s*%%/;
                const startMatch = text.match(startRe);
                if (!startMatch) return text;

                const insertPos = startMatch.index! + startMatch[0].length;
                return text.slice(0, insertPos) + '\n' + lineContent + text.slice(insertPos);
            }
        };

        // FIXED: Always process BOTH colors and borders to preserve existing values
        const hasColors = colors.some(c => c);
        if (hasColors) {
            newBlock = updateLine('columns:colors', colors, newBlock);
        } else {
            // Remove colors line if all are empty
            newBlock = newBlock.replace(/%%\s*columns:colors\s+[^\n%]+\s*%%\n?/g, '');
        }

        const hasBorders = borders.some(b => b);
        if (hasBorders) {
            newBlock = updateLine('columns:borders', borders, newBlock);
        } else {
            // Remove borders line if all are empty
            newBlock = newBlock.replace(/%%\s*columns:borders\s+[^\n%]+\s*%%\n?/g, '');
        }

        editor.replaceRange(newBlock, editor.offsetToPos(startPos), editor.offsetToPos(endPos));
    }

    /**
     * Register editor commands for inserting column layouts
     */
    private registerCommands() {
        // Insert 2 columns
        this.addCommand({
            id: 'insert-columns-2',
            name: 'Insert 2 columns',
            editorCallback: (editor: Editor) => {
                this.insertColumns(editor, 2);
            }
        });

        // Insert 3 columns
        this.addCommand({
            id: 'insert-columns-3',
            name: 'Insert 3 columns',
            editorCallback: (editor: Editor) => {
                this.insertColumns(editor, 3);
            }
        });

        // Insert 4 columns
        this.addCommand({
            id: 'insert-columns-4',
            name: 'Insert 4 columns',
            editorCallback: (editor: Editor) => {
                this.insertColumns(editor, 4);
            }
        });

        // Generic insert with prompt
        this.addCommand({
            id: 'insert-columns',
            name: 'Insert columns...',
            editorCallback: (editor: Editor) => {
                this.insertColumns(editor, 2);
                new Notice('Inserted 2 columns. Use Ctrl+P for more options.');
            }
        });

        // Command to change column color
        this.addCommand({
            id: 'change-column-color',
            name: 'Change column color...',
            callback: () => {
                this.enterColumnSelectionMode('color');
            }
        });

        this.addCommand({
            id: 'change-column-border',
            name: 'Change column border...',
            callback: () => {
                this.enterColumnSelectionMode('border');
            }
        });
    }

    /**
     * Insert using the active editor (for ribbon)
     */
    private insertColumnsAtActive(numColumns: number) {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const editor = view?.editor;
        if (!editor) {
            new Notice('No active note to insert columns.');
            return;
        }
        this.insertColumns(editor, numColumns);
    }

    /**
     * Insert a column layout at the current cursor position
     * FIXED: Improved cursor positioning and line breaks
     */
    private insertColumns(editor: Editor, numColumns: number) {
        const cursor = editor.getCursor();
        const lineText = editor.getLine(cursor.line);

        // Ensure we are on a clean block or separated properly
        const needsKpPre = lineText.trim().length > 0;

        const lines: string[] = [];

        // Add preceding newline if current line has text
        if (needsKpPre) lines.push('');

        // Blank line before block for safety
        lines.push('');

        lines.push(`%% columns:start ${numColumns} %%`);
        for (let i = 0; i < numColumns; i++) {
            lines.push(`Column ${i + 1}`);
            if (i < numColumns - 1) {
                lines.push('--- col ---');
            }
        }
        lines.push('%% columns:end %%');

        // Blank line after block for safety and cursor placement
        lines.push('');

        const template = lines.join('\n');
        editor.replaceRange(template, cursor);

        // FIXED: Set cursor AFTER the block, not inside the hidden content.
        const numLinesInserted = lines.length;

        editor.setCursor({
            line: cursor.line + numLinesInserted - 1 + (needsKpPre ? 0 : 0),
            ch: 0
        });

        // Focus editor to ensure cursor is active
        editor.focus();
    }

    /**
     * Post-processor for Reading mode
     * Transforms marker-based columns into layout
     * 
     * Uses document-level slice approach for accurate block detection.
     */
    columnsPostProcessor(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
        const info = ctx.getSectionInfo(el);
        if (!info?.text) return;

        // Get full document lines
        const docLines = info.text.split('\n');
        const elStart = info.lineStart;
        const elEnd = info.lineEnd;

        const startRe = /%%\s*columns:start\s+(\d+)\s*%%/i;
        const endRe = /%%\s*columns:end\s*%%/i;

        // Check if this element's first line contains a columns:start marker
        const firstLine = docLines[elStart] || '';
        const startMatch = firstLine.match(startRe);

        if (startMatch) {
            // This element starts a columns block - find the end and render
            const numColumns = parseInt(startMatch[1], 10);
            if (isNaN(numColumns) || numColumns < 1 || numColumns > 6) return;

            // Find the matching end marker in document
            let blockEndLine = -1;
            for (let i = elStart + 1; i < docLines.length; i++) {
                if (endRe.test(docLines[i])) {
                    blockEndLine = i;
                    break;
                }
            }

            if (blockEndLine === -1) return; // No end marker found

            // Extract block content using document-level slice (NOT elementLines!)
            const blockLines = docLines.slice(elStart + 1, blockEndLine);

            // Render the columns
            this.renderColumnsFromLines(el, blockLines, numColumns);

            // FIX: Preserve text that appears AFTER columns:end but within the same element
            if (blockEndLine < elEnd) {
                const trailingLines = docLines.slice(blockEndLine + 1, elEnd + 1);
                if (trailingLines.length > 0) {
                    const trailingContainer = document.createElement('div');
                    trailingContainer.className = 'live-columns-trailing-content';
                    trailingLines.forEach(line => {
                        if (line.trim()) {
                            const p = document.createElement('p');
                            p.innerText = line;
                            trailingContainer.appendChild(p);
                        }
                    });
                    if (trailingContainer.hasChildNodes()) {
                        el.appendChild(trailingContainer);
                    }
                }
            }
            return;
        }

        // This element doesn't start a columns block
        // Check if it falls STRICTLY within a columns block range - if so, hide it

        // Find all column blocks in the document
        let currentBlockStart = -1;
        for (let i = 0; i < docLines.length; i++) {
            if (startRe.test(docLines[i])) {
                currentBlockStart = i;
            }
            if (endRe.test(docLines[i]) && currentBlockStart !== -1) {
                // Check if this element falls STRICTLY within this block
                // elStart > currentBlockStart: element starts after the start marker line
                // elEnd <= i: element ends at or before the end marker line
                if (elStart > currentBlockStart && elEnd <= i) {
                    el.addClass('live-columns-marker-hidden');
                    return;
                }
                currentBlockStart = -1;
            }
        }

        // Element is not inside any columns block - leave it visible
    }

    /**
     * Helper method to render columns from block content lines
     */
    private renderColumnsFromLines(el: HTMLElement, blockLines: string[], numColumns: number) {
        const colorRe = /^%%\s*columns:colors\s+([^\n%]+)\s*%%/i;
        const borderRe = /^%%\s*columns:borders\s+([^\n%]+)\s*%%/i;
        const sepRe = /^---\s*col\s*---$/im;

        let colors: string[] = [];
        let borders: string[] = [];

        // Consume optional metadata lines at the top (order-independent, skipping blanks)
        let idx = 0;
        while (idx < blockLines.length) {
            const line = blockLines[idx].trim();
            if (!line) {
                idx += 1;
                continue;
            }

            const colorMatch = line.match(colorRe);
            if (colorMatch) {
                colors = colorMatch[1].split('|').map(c => c.trim());
                blockLines.splice(idx, 1);
                continue;
            }

            const borderMatch = line.match(borderRe);
            if (borderMatch) {
                borders = borderMatch[1].split('|').map(c => c.trim());
                blockLines.splice(idx, 1);
                continue;
            }

            break;
        }

        const bodyText = blockLines.join('\n').trim();

        // Split by separator
        const parts = bodyText.split(sepRe);

        // Build columns container
        const container = document.createElement('div');
        container.className = `live-columns-container live-columns-${numColumns}`;

        for (let ci = 0; ci < numColumns; ci++) {
            const colDiv = document.createElement('div');
            colDiv.className = 'live-column';
            colDiv.setAttribute('data-column-index', ci.toString());

            const colorClass = colors[ci]?.trim();
            if (colorClass) {
                colDiv.classList.add(`live-col-${colorClass}`);
            }

            const borderClass = borders[ci]?.trim();
            if (borderClass) {
                colDiv.classList.add(`live-border-${borderClass}`);
            }

            const contentText = (parts[ci] || '').trim();
            if (contentText.length === 0) {
                const ph = document.createElement('p');
                ph.className = 'live-column-empty';
                ph.innerText = `(Column ${ci + 1})`;
                colDiv.appendChild(ph);
            } else {
                // Render content - split by newlines for paragraphs
                // FIXED: Also render empty lines as line breaks to preserve spacing
                const contentLines = contentText.split('\n');
                contentLines.forEach((line, idx) => {
                    if (line.trim()) {
                        const p = document.createElement('p');
                        p.innerText = line;
                        colDiv.appendChild(p);
                    } else if (idx > 0 && idx < contentLines.length - 1) {
                        // Empty line in the middle - add a line break for spacing
                        const br = document.createElement('br');
                        colDiv.appendChild(br);
                    }
                });
            }

            container.appendChild(colDiv);
        }

        // Clear element content and append columns container
        while (el.firstChild) {
            el.removeChild(el.firstChild);
        }
        el.appendChild(container);
    }
}

/**
 * Color Picker Modal with visual grid
 */
class ColorPickerModal extends Modal {
    private palette: { name: string; token: string; color: string }[];
    private typeName: string;
    private onSelect: (token: string, name: string) => void;

    constructor(
        app: App,
        palette: { name: string; token: string; color: string }[],
        typeName: string,
        onSelect: (token: string, name: string) => void
    ) {
        super(app);
        this.palette = palette;
        this.typeName = typeName;
        this.onSelect = onSelect;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('live-columns-color-picker');

        // Title
        contentEl.createEl('h3', {
            text: `Choose ${this.typeName} color`,
            cls: 'color-picker-title'
        });

        // Color grid container
        const grid = contentEl.createDiv({ cls: 'color-grid' });

        this.palette.forEach((p) => {
            const swatch = grid.createDiv({ cls: 'color-swatch' });
            swatch.title = p.name;

            // Use setCssProps for dynamic background color
            if (p.token === '') {
                // Default (transparent) - use special class
                swatch.addClass('color-swatch-default');
            } else {
                swatch.setCssProps({ '--swatch-color': p.color });
                swatch.style.backgroundColor = p.color;
            }

            swatch.addEventListener('click', () => {
                this.onSelect(p.token, p.name);
                this.close();
            });
        });

        // Cancel button
        const footer = contentEl.createDiv({ cls: 'color-picker-footer' });
        const cancelBtn = footer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}