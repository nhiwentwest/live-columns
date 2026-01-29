import {
    ViewPlugin,
    ViewUpdate,
    Decoration,
    DecorationSet,
    EditorView,
    WidgetType,
} from '@codemirror/view';
import { RangeSetBuilder, Transaction, EditorState } from '@codemirror/state';
import { editorLivePreviewField } from 'obsidian';

/**
 * Column data structure with line-based positioning
 */
interface ColumnsBlock {
    numColumns: number;
    columns: string[]; // raw markdown per column
    startPos: number;  // character offset of start marker
    endPos: number;    // character offset of end marker
    startMarkerLen: number;
    endMarkerLen: number;
    colors: string[];  // per-column background color tokens
    borders: string[]; // per-column border color tokens
}

/**
 * Build marker-based columns markdown
 * %% columns:start N %%
 * %% columns:colors ... %%
 * %% columns:borders ... %%
 * col1
 * --- col ---
 * col2
 * %% columns:end %%
 * 
 * FIXED: Now accepts both colors AND borders
 */
function buildColumnsMarkdown(numColumns: number, columns: string[], colors?: string[], borders?: string[]): string {
    const lines: string[] = [];
    const normalized = [...columns];
    while (normalized.length < numColumns) normalized.push('');

    lines.push(`%% columns:start ${numColumns} %%`);

    // Add colors line if provided
    if (colors && colors.length) {
        const colorLine = colors.slice(0, numColumns).join('|');
        lines.push(`%% columns:colors ${colorLine} %%`);
    }

    // Add borders line if provided
    if (borders && borders.length) {
        const borderLine = borders.slice(0, numColumns).join('|');
        lines.push(`%% columns:borders ${borderLine} %%`);
    }

    normalized.slice(0, numColumns).forEach((col, idx) => {
        if (idx > 0) lines.push('--- col ---');
        lines.push(col);
    });

    lines.push('%% columns:end %%');
    return lines.join('\n');
}

/**
 * Widget that renders the columns container with proper WYSIWYG editing
 */
/**
 * Widget that renders the columns container with proper WYSIWYG editing
 */
class ColumnsWidget extends WidgetType {
    private container: HTMLElement | null = null;
    private isUpdating = false;
    private columnContents: string[];

    constructor(private block: ColumnsBlock, private view: EditorView) {
        super();
        this.columnContents = [...this.block.columns];
        while (this.columnContents.length < this.block.numColumns) {
            this.columnContents.push('');
        }
    }

    toDOM(): HTMLElement {
        this.container = document.createElement('div');
        this.container.className = `live-columns-container live-columns-${this.block.numColumns}`;
        this.container.setAttribute('data-live-columns', 'true');
        // Make container focusable for delete handling
        this.container.setAttribute('tabindex', '0');

        for (let i = 0; i < this.block.numColumns; i++) {
            const colDiv = this.createColumn(i);
            this.container.appendChild(colDiv);
        }

        // Handle delete key on container (when selecting whole widget)
        this.container.addEventListener('keydown', (e) => {
            // Only handle when container itself is focused, not when editing a column
            const target = e.target as HTMLElement;
            if (target.hasAttribute('contenteditable')) return;

            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                e.stopPropagation();
                this.deleteEntireBlock();
            }
        });

        return this.container;
    }

    /**
     * Delete the entire column block from the document
     */
    private deleteEntireBlock(): void {
        const from = this.block.startPos;
        const to = this.block.endPos;

        // Also delete trailing newline if present
        const doc = this.view.state.doc;
        let deleteTo = to;
        if (deleteTo < doc.length && doc.sliceString(deleteTo, deleteTo + 1) === '\n') {
            deleteTo++;
        }

        this.view.dispatch({
            changes: { from, to: deleteTo }
        });
    }


    private createColumn(index: number): HTMLElement {
        const colDiv = document.createElement('div');
        colDiv.className = 'live-column';
        colDiv.setAttribute('data-column-index', index.toString());
        colDiv.setAttribute('contenteditable', 'true');
        colDiv.setAttribute('spellcheck', 'true');
        colDiv.setAttribute('data-placeholder', `Column ${index + 1}`);

        // Apply background color class if specified
        const colorClass = this.block.colors[index]?.trim();
        if (colorClass) {
            colDiv.classList.add(`live-col-${colorClass}`);
        }

        // Apply border color class if specified
        const borderClass = this.block.borders[index]?.trim();
        if (borderClass) {
            colDiv.classList.add(`live-border-${borderClass}`);
        }

        // Initial render: Show rendered HTML
        const content = this.columnContents[index] || '';
        this.setColumnContent(colDiv, content, false); // false = rendered mode

        // Handle keyboard navigation
        colDiv.addEventListener('keydown', (e) => {
            this.handleKeydown(e, index);
        });

        // === EDIT MODE TOGGLE ===
        // On FOCUS: Switch to raw markdown (so user can edit ## etc)
        colDiv.addEventListener('focus', () => {
            const currentContent = this.columnContents[index] || '';
            this.setColumnContent(colDiv, currentContent, true); // true = raw mode
            colDiv.classList.add('live-column-editing');
        });

        // On BLUR: Switch back to rendered HTML and sync
        colDiv.addEventListener('blur', () => {
            // First extract the raw text the user typed
            const rawText = colDiv.innerText || '';
            this.columnContents[index] = rawText.trim();

            // Then render it back to HTML
            this.setColumnContent(colDiv, this.columnContents[index], false);
            colDiv.classList.remove('live-column-editing');

            // Sync to source document
            this.syncToSource();
        });

        // Sync on input with debounce to catch edits before any rebuild
        let inputTimeout: NodeJS.Timeout | null = null;
        colDiv.addEventListener('input', () => {
            // Update local state immediately
            const rawText = colDiv.innerText || '';
            this.columnContents[index] = rawText.trim();

            // Debounced sync to document
            if (inputTimeout) clearTimeout(inputTimeout);
            inputTimeout = setTimeout(() => {
                this.syncToSource();
            }, 300);
        });

        // Strip HTML formatting on paste - only keep plain text
        // This ensures pasted content uses column's CSS fonts
        colDiv.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = e.clipboardData?.getData('text/plain') || '';

            // Use modern InputEvent API instead of deprecated execCommand
            const selection = window.getSelection();
            if (selection && selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                range.deleteContents();
                const textNode = document.createTextNode(text);
                range.insertNode(textNode);

                // Move cursor to end of inserted text
                range.setStartAfter(textNode);
                range.setEndAfter(textNode);
                selection.removeAllRanges();
                selection.addRange(range);
            }
        });

        return colDiv;
    }

    /**
     * Set column content in either rendered or raw mode
     * @param colDiv - The column element
     * @param content - The markdown content
     * @param rawMode - If true, show raw markdown text. If false, show rendered HTML.
     */
    private setColumnContent(colDiv: HTMLElement, content: string, rawMode: boolean): void {
        // Clear existing content
        while (colDiv.firstChild) {
            colDiv.removeChild(colDiv.firstChild);
        }

        if (rawMode) {
            // RAW MODE: Show plain text for editing
            colDiv.innerText = content || '';
        } else {
            // RENDERED MODE: Show formatted HTML
            const htmlContent = this.renderContent(content);
            const parser = new DOMParser();
            const doc = parser.parseFromString(htmlContent, 'text/html');
            Array.from(doc.body.childNodes).forEach(node => colDiv.appendChild(node));
        }
    }

    /**
     * Render markdown content as HTML
     */
    private renderContent(text: string): string {
        if (!text.trim()) {
            return '<br>'; // Return clean break for empty columns to allow clicking
        }

        let html = text
            // Escape HTML first
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            // Headings (must be at start of line)
            .replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes, content) => {
                const level = hashes.length;
                return `<h${level}>${content}</h${level}>`;
            })
            // Bold
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            // Italic
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            // Code
            .replace(/`(.+?)`/g, '<code>$1</code>')
            // Links
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
            // Unordered lists
            .replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>')
            // Numbered lists
            .replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>')
            // Wrap consecutive list items
            .replace(/((?:<li>.+?<\/li>\n?)+)/g, '<ul>$1</ul>')
            // Paragraphs (lines not already wrapped)
            .replace(/^(?!<[hulo])(.+)$/gm, '<div>$1</div>');

        // Simply convert all newlines to <br>
        // CSS will handle proper spacing via margins on block elements
        html = html.replace(/\n/g, '<br>');

        return html;
    }

    /**
     * Extract plain text/markdown from HTML
     * FIXED: Improved logic to handle div/br combinations without adding extra lines
     */
    private extractContent(el: HTMLElement): string {
        const clone = el.cloneNode(true) as HTMLElement;

        let text = clone.innerHTML
            // Headings
            .replace(/<h(\d)>(.+?)<\/h\1>/gi, (_, level, content) => {
                return '#'.repeat(parseInt(level)) + ' ' + content + '\n';
            })
            // Bold
            .replace(/<strong>(.+?)<\/strong>/gi, '**$1**')
            .replace(/<b>(.+?)<\/b>/gi, '**$1**')
            // Italic
            .replace(/<em>(.+?)<\/em>/gi, '*$1*')
            .replace(/<i>(.+?)<\/i>/gi, '*$1*')
            // Code
            .replace(/<code>(.+?)<\/code>/gi, '`$1`')
            // Links
            .replace(/<a href="([^"]+)">(.+?)<\/a>/gi, '[$2]($1)')
            // List items
            .replace(/<li>(.+?)<\/li>/gi, '- $1\n')
            // Remove ul/ol wrappers
            .replace(/<\/?[uo]l>/gi, '')

            // DIV handling: 
            // 1. <div><br></div> is an empty line -> \n
            .replace(/<div[^>]*><br><\/div>/gi, '\n')
            // 2. <div>Content</div> is a line -> \nContent
            .replace(/<div[^>]*>/gi, '\n')
            .replace(/<\/div>/gi, '')

            // P tags
            .replace(/<p[^>]*>/gi, '\n')
            .replace(/<\/p>/gi, '')

            // Line breaks
            .replace(/<br\s*\/?>/gi, '\n')

            // Strip remaining tags
            .replace(/<[^>]+>/g, '')

            // Decode entities
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&nbsp;/g, ' ')

            // Cleanup whitespace
            .replace(/^\n+/, '')      // Remove leading newlines
            .replace(/\n+$/, '')      // Remove trailing newlines
            .replace(/\n{3,}/g, '\n\n') // Max 2 consecutive newlines
            .trim();

        return text;
    }

    private syncToSource() {
        if (this.isUpdating || !this.container) return;
        this.isUpdating = true;

        try {
            const newContents: string[] = [];
            const columns = this.container.querySelectorAll('.live-column');

            columns.forEach((col) => {
                const content = this.extractContent(col as HTMLElement);
                newContents.push(content);
            });

            // Check if anything actually changed to avoid unnecessary updates
            const hasChanges = newContents.some((content, i) =>
                content !== (this.columnContents[i] || '')
            );

            if (!hasChanges) {
                this.isUpdating = false;
                return;
            }

            this.columnContents = newContents;

            const doc = this.view.state.doc;
            const text = doc.toString();

            // Re-find the block position in current document (positions may have shifted)
            const startRe = /%%\s*columns:start\s+(\d+)\s*%{1,2}/gi;
            let currentBlock = null;
            let match;

            while ((match = startRe.exec(text)) !== null) {
                const startPos = match.index;
                const endRe = /%%\s*columns:end\s*%{1,2}/gi;
                endRe.lastIndex = startRe.lastIndex;
                const endMatch = endRe.exec(text);

                if (endMatch) {
                    const endPos = endMatch.index + endMatch[0].length;
                    // Check if this is our block (numColumns matches)
                    const num = parseInt(match[1], 10);
                    if (num === this.block.numColumns) {
                        // Re-parse colors and borders from current document
                        const blockContent = text.slice(startRe.lastIndex, endMatch.index);
                        const colorLineRe = /%%\s*columns:colors\s+([^\n%]+)\s*%{1,2}/i;
                        const borderLineRe = /%%\s*columns:borders\s+([^\n%]+)\s*%{1,2}/i;

                        const colorMatch = blockContent.match(colorLineRe);
                        const borderMatch = blockContent.match(borderLineRe);

                        currentBlock = {
                            startPos,
                            endPos,
                            colors: colorMatch ? colorMatch[1].split('|').map(c => c.trim()) : [],
                            borders: borderMatch ? borderMatch[1].split('|').map(b => b.trim()) : []
                        };
                        break;
                    }
                }
            }

            if (!currentBlock) {
                // Block not found, use original positions
                currentBlock = {
                    startPos: this.block.startPos,
                    endPos: this.block.endPos,
                    colors: this.block.colors,
                    borders: this.block.borders
                };
            }

            const from = Math.max(0, Math.min(currentBlock.startPos, doc.length));
            const to = Math.max(from, Math.min(currentBlock.endPos, doc.length));

            const newMarkdown = buildColumnsMarkdown(
                this.block.numColumns,
                newContents,
                currentBlock.colors,  // Use current colors from document
                currentBlock.borders   // Use current borders from document
            );

            const transaction = this.view.state.update({
                changes: {
                    from,
                    to,
                    insert: newMarkdown
                },
                annotations: Transaction.userEvent.of('input.columns')
            });

            this.view.dispatch(transaction);
        } catch (e) {
            console.error('Live Columns: sync error', e);
        } finally {
            this.isUpdating = false;
        }
    }

    // ... (Giữ nguyên handleKeydown, eq, ignoreEvent, destroy) ...
    private handleKeydown(e: KeyboardEvent, columnIndex: number) {
        if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.stopPropagation();
            const columns = this.container?.querySelectorAll('.live-column');
            const currentCol = columns?.[columnIndex] as HTMLElement;
            if (currentCol) {
                const range = document.createRange();
                range.selectNodeContents(currentCol);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
            }
            return;
        }

        if (e.key === 'Tab' && this.container) {
            e.preventDefault();
            const columns = this.container.querySelectorAll('.live-column');
            const nextIndex = e.shiftKey
                ? (columnIndex - 1 + columns.length) % columns.length
                : (columnIndex + 1) % columns.length;

            const nextCol = columns[nextIndex] as HTMLElement;
            if (nextCol) {
                nextCol.focus();
                const range = document.createRange();
                range.selectNodeContents(nextCol);
                range.collapse(false);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
            }
        }
    }

    eq(other: ColumnsWidget): boolean {
        // DON'T compare positions - they change when typing above the column
        // Only compare actual content to prevent unnecessary re-creation
        if (this.block.numColumns !== other.block.numColumns) return false;
        if (this.block.columns.length !== other.block.columns.length) return false;
        for (let i = 0; i < this.block.columns.length; i++) {
            if (this.block.columns[i] !== other.block.columns[i]) return false;
        }
        return true;
    }

    /**
     * Update the existing DOM instead of recreating it
     * This preserves user edits in contenteditable when document changes elsewhere
     */
    updateDOM(dom: HTMLElement, view: EditorView): boolean {
        // Update our view reference
        this.view = view;
        this.container = dom;

        // Update block positions (they may have shifted)
        // But DON'T update column contents - preserve user's edits

        // Return true to indicate we handled the update
        // (no need to recreate the DOM)
        return true;
    }

    ignoreEvent(): boolean {
        return true;
    }

    destroy() {
        this.container = null;
    }
}

/**
 * Parse the document to find column blocks using line-based approach
 */
function findColumnsBlocks(view: EditorView): ColumnsBlock[] {
    const text = view.state.doc.toString();
    const blocks: ColumnsBlock[] = [];
    // Allow one or two trailing % to be forgiving on user input
    const startRe = /%%\s*columns:start\s+(\d+)\s*%{1,2}/gi;
    let match: RegExpExecArray | null;

    while ((match = startRe.exec(text)) !== null) {
        const num = parseInt(match[1], 10);
        if (isNaN(num) || num < 1 || num > 6) continue;

        const startPos = match.index;
        const startMarkerLen = match[0].length;

        // Find the end marker first
        const endRe = /%%\s*columns:end\s*%{1,2}/gi;
        endRe.lastIndex = startRe.lastIndex;
        const endMatch = endRe.exec(text);
        if (!endMatch) continue;

        const endPos = endMatch.index + endMatch[0].length;
        const endMarkerLen = endMatch[0].length;

        // Get the block content between start and end markers
        const blockContent = text.slice(startRe.lastIndex, endMatch.index);
        const blockLines = blockContent.split(/\r?\n/);

        // Parse metadata lines using LINE-BY-LINE approach (same as Reading View)
        const colorLineRe = /^%%\s*columns:colors\s+([^\n%]+)\s*%{1,2}\s*$/i;
        const borderLineRe = /^%%\s*columns:borders\s+([^\n%]+)\s*%{1,2}\s*$/i;
        let colors: string[] = [];
        let borders: string[] = [];
        let metadataLen = 0; // Track length of metadata lines to hide

        // Consume metadata lines from the beginning (order-independent, skipping blanks)
        let idx = 0;
        while (idx < blockLines.length) {
            const line = blockLines[idx];
            const trimmedLine = line.trim();
            if (!trimmedLine) {
                // Empty line at start - remove it and count its length
                metadataLen += line.length + 1; // +1 for newline
                blockLines.splice(idx, 1);
                continue;
            }

            const colorMatch = trimmedLine.match(colorLineRe);
            if (colorMatch) {
                colors = colorMatch[1].split('|').map(c => c.trim());
                metadataLen += line.length + 1; // +1 for newline
                blockLines.splice(idx, 1);
                continue;
            }

            const borderMatch = trimmedLine.match(borderLineRe);
            if (borderMatch) {
                borders = borderMatch[1].split('|').map(b => b.trim());
                metadataLen += line.length + 1; // +1 for newline
                blockLines.splice(idx, 1);
                continue;
            }

            // Hit a non-metadata line, stop consuming
            break;
        }

        // Include metadata lines in the hidden marker area
        const totalStartMarkerLen = startMarkerLen + metadataLen;

        // Parse remaining lines as column content
        const bodyText = blockLines.join('\n');
        const cols = parseColumnsFromBody(bodyText, num);

        blocks.push({
            numColumns: num,
            columns: cols,
            startPos,
            endPos,
            startMarkerLen: totalStartMarkerLen,
            endMarkerLen,
            colors,
            borders
        });

        startRe.lastIndex = endMatch.index + endMatch[0].length;
    }

    return blocks;
}

function parseColumnsFromBody(body: string, numColumns: number): string[] {
    const parts = body.split(/^\s*---\s*col\s*---\s*$/im);
    const result: string[] = [];
    for (let i = 0; i < numColumns; i++) {
        result.push((parts[i] || '').trim());
    }
    return result;
}

/**
 * ViewPlugin that manages column decorations
 */
const columnsViewPlugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;
        private lastIsLivePreview: boolean;

        constructor(view: EditorView) {
            this.decorations = this.buildDecorations(view);
            this.lastIsLivePreview = view.state.field(editorLivePreviewField, false) || false;
        }

        update(update: ViewUpdate) {
            // Rebuild on any doc or viewport change.
            // Even for our own edits we need to recompute ranges,
            // otherwise widgets point at stale offsets and disappear.
            const isLivePreviewNow = update.view.state.field(editorLivePreviewField, false) || false;
            const modeChanged = isLivePreviewNow !== this.lastIsLivePreview;
            this.lastIsLivePreview = isLivePreviewNow;

            if (update.docChanged || update.viewportChanged || modeChanged) {
                this.decorations = this.buildDecorations(update.view);
            }
        }

        buildDecorations(view: EditorView): DecorationSet {
            try {
                // Only render columns in Live Preview mode, not in Source mode
                const isLivePreview = view.state.field(editorLivePreviewField, false);
                if (!isLivePreview) {
                    return Decoration.none;
                }

                const builder = new RangeSetBuilder<Decoration>();
                const blocks = findColumnsBlocks(view);

                for (const block of blocks) {
                    // Clamp decoration range to valid document bounds
                    const docLength = view.state.doc.length;
                    const from = Math.max(0, Math.min(block.startPos, docLength));
                    const to = Math.max(from, Math.min(block.endPos, docLength));
                    if (from === to) continue;

                    // Add widget at block start (rendered as block via CSS, but not a block decoration)
                    const widget = Decoration.widget({
                        widget: new ColumnsWidget(block, view),
                        // keep inline to satisfy Obsidian CM6 restriction
                        block: false
                    });

                    // Add in order: widget -> start marker -> body -> end marker
                    builder.add(from, from, widget);

                    // Hide start marker text
                    const startHideTo = Math.min(docLength, from + block.startMarkerLen);
                    if (startHideTo > from) {
                        builder.add(
                            from,
                            startHideTo,
                            Decoration.mark({ class: 'live-columns-marker-hidden', inclusive: false })
                        );
                    }

                    // Hide end marker text
                    const endFrom = Math.max(from, to - block.endMarkerLen);

                    // Hide body between markers (markdown source)
                    if (endFrom > startHideTo) {
                        builder.add(
                            startHideTo,
                            endFrom,
                            Decoration.mark({ class: 'live-columns-body-hidden', inclusive: false })
                        );
                    }

                    // Hide end marker text
                    if (to > endFrom) {
                        builder.add(
                            endFrom,
                            to,
                            Decoration.mark({ class: 'live-columns-marker-hidden', inclusive: false })
                        );
                    }
                }

                return builder.finish();
            } catch (e) {
                console.error('Live Columns: decoration build error', e);
                return Decoration.none;
            }
        }
    },
    {
        decorations: (v) => v.decorations,
    }
);

/**
 * Transaction filter that blocks input on collapsed lines
 * This runs BEFORE the transaction is applied, preventing corruption
 */
const blockCollapsedInput = EditorState.transactionFilter.of((tr) => {
    // Only filter in live preview mode
    const isLivePreview = tr.startState.field(editorLivePreviewField, false);
    if (!isLivePreview) return tr;

    // If no doc changes, allow the transaction (just cursor movement, etc)
    if (!tr.docChanged) return tr;

    // Get the position where the change is happening
    const changes = tr.changes;
    let blocked = false;

    // Check each change
    changes.iterChanges((fromA, toA) => {
        // Find if this change is inside a collapsed block
        const doc = tr.startState.doc;
        const text = doc.toString();
        // Use same regex as findColumnsBlocks
        const startPattern = /%%\s*columns:start\s+(\d+)\s*%{1,2}/gi;
        const endPattern = /%%\s*columns:end\s*%{1,2}/gi;

        let match;
        while ((match = startPattern.exec(text)) !== null) {
            const blockStart = match.index;
            endPattern.lastIndex = startPattern.lastIndex;
            const endMatch = endPattern.exec(text);
            if (endMatch) {
                const blockEnd = endMatch.index + endMatch[0].length;
                const firstLineEnd = blockStart + match[0].length;

                // If change is in the hidden zone (after first line, before block end)
                if (fromA > firstLineEnd && fromA <= blockEnd) {
                    blocked = true;
                }
            }
        }
    });

    // If blocked, return empty transaction (cancel the input)
    if (blocked) {
        return [];
    }

    return tr;
});

/**
 * Auto-jump cursor away from collapsed lines using requestAnimationFrame for speed
 */
const cursorAutoJump = EditorView.updateListener.of((update) => {
    if (!update.selectionSet) return;

    const isLivePreview = update.state.field(editorLivePreviewField, false);
    if (!isLivePreview) return;

    const cursor = update.state.selection.main.head;
    const doc = update.state.doc;
    const text = doc.toString();

    // Use same regex as findColumnsBlocks
    const startPattern = /%%\s*columns:start\s+(\d+)\s*%{1,2}/gi;
    const endPattern = /%%\s*columns:end\s*%{1,2}/gi;

    let match;
    while ((match = startPattern.exec(text)) !== null) {
        const blockStart = match.index;
        const firstLineEnd = blockStart + match[0].length;

        endPattern.lastIndex = startPattern.lastIndex;
        const endMatch = endPattern.exec(text);
        if (endMatch) {
            const blockEnd = endMatch.index + endMatch[0].length;

            // If cursor is in hidden zone (after first line, before or at block end)
            if (cursor > firstLineEnd && cursor <= blockEnd) {
                const targetPos = Math.min(blockEnd + 1, doc.length);

                // Use requestAnimationFrame for immediate response
                requestAnimationFrame(() => {
                    update.view.dispatch({
                        selection: { anchor: targetPos }
                    });
                });
                return;
            }
        }
    }
});

/**
 * Export the extension
 */
export function liveColumnsExtension() {
    return [columnsViewPlugin, blockCollapsedInput, cursorAutoJump];
}