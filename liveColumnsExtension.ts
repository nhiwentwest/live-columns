import {
    ViewPlugin,
    ViewUpdate,
    Decoration,
    DecorationSet,
    EditorView,
    WidgetType,
} from '@codemirror/view';
import { RangeSetBuilder, Transaction } from '@codemirror/state';
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

        for (let i = 0; i < this.block.numColumns; i++) {
            const colDiv = this.createColumn(i);
            this.container.appendChild(colDiv);
        }

        return this.container;
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

        const content = this.columnContents[index] || '';
        colDiv.innerHTML = this.renderContent(content);

        // Handle keyboard navigation
        colDiv.addEventListener('keydown', (e) => {
            this.handleKeydown(e as KeyboardEvent, index);
        });

        // Only sync when user leaves the column (blur) - no interruption while typing
        colDiv.addEventListener('blur', () => {
            this.syncToSource();
        });

        return colDiv;
    }

    /**
     * Render markdown content as HTML
     * Uses simple rendering - for full markdown, would need Obsidian's MarkdownRenderer
     */
    private renderContent(text: string): string {
        if (!text.trim()) {
            return '<br>';
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
            .replace(/^(?!<[hulo])(.+)$/gm, '<div>$1</div>')
            // Line breaks
            .replace(/\n/g, '<br>');

        // The original logic for wrapping <li> in <ul> is now handled by the new regex above.
        // This block is no longer needed.
        // html = html.replace(/(<li>.*?<\/li>)(?:<br>)?/g, '$1');
        // if (html.includes('<li>')) {
        //     html = html.replace(/(<li>[\s\S]*?<\/li>)+/g, '<ul>$&</ul>');
        // }

        return html;
    }

    /**
     * Extract plain text/markdown from HTML
     * FIXED: Now properly handles div/p tags created by Enter key in contentEditable
     */
    private extractContent(el: HTMLElement): string {
        // Clone to avoid modifying the original
        const clone = el.cloneNode(true) as HTMLElement;

        // Convert back to markdown-ish text
        let text = clone.innerHTML
            // DIV and P tags become newlines (contentEditable creates these on Enter)
            .replace(/<div[^>]*>/gi, '\n')
            .replace(/<\/div>/gi, '')
            .replace(/<p[^>]*>/gi, '\n')
            .replace(/<\/p>/gi, '')
            // Line breaks
            .replace(/<br\s*\/?>/gi, '\n')
            // Headings
            .replace(/<h(\d)>(.+?)<\/h\1>/gi, (_, level, content) => {
                return '#'.repeat(parseInt(level)) + ' ' + content + '\n';
            })
            // Bold
            .replace(/<strong>(.+?)<\/strong>/gi, '**$1**')
            // Italic
            .replace(/<em>(.+?)<\/em>/gi, '*$1*')
            // Code
            .replace(/<code>(.+?)<\/code>/gi, '`$1`')
            // Links
            .replace(/<a href="([^"]+)">(.+?)<\/a>/gi, '[$2]($1)')
            // List items
            .replace(/<li>(.+?)<\/li>/gi, '- $1\n')
            // Remove ul/ol wrappers
            .replace(/<\/?[uo]l>/gi, '')
            // Remove other tags
            .replace(/<[^>]+>/g, '')
            // Decode entities
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&nbsp;/g, ' ')
            // Clean up: remove leading newline and extra newlines
            .replace(/^\n/, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        return text;
    }

    /**
     * Sync all column contents back to the markdown source
     * FIXED: Now passes BOTH colors and borders to buildColumnsMarkdown
     */
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

            const hasChanges = newContents.some((content, i) =>
                content !== (this.columnContents[i] || '')
            );

            if (!hasChanges) {
                this.isUpdating = false;
                return;
            }

            this.columnContents = newContents;

            const doc = this.view.state.doc;
            const from = Math.max(0, Math.min(this.block.startPos, doc.length));
            const to = Math.max(from, Math.min(this.block.endPos, doc.length));

            // KEY FIX: Pass BOTH colors AND borders
            const newMarkdown = buildColumnsMarkdown(
                this.block.numColumns,
                newContents,
                this.block.colors,
                this.block.borders  // <-- THIS WAS MISSING!
            );

            // Dispatch transaction with proper annotation
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

    /**
     * Handle keyboard navigation between columns
     */
    private handleKeydown(e: KeyboardEvent, columnIndex: number) {
        if (e.key === 'Tab' && this.container) {
            e.preventDefault();
            const columns = this.container.querySelectorAll('.live-column');
            const nextIndex = e.shiftKey
                ? (columnIndex - 1 + columns.length) % columns.length
                : (columnIndex + 1) % columns.length;

            const nextCol = columns[nextIndex] as HTMLElement;
            if (nextCol) {
                nextCol.focus();
                // Move cursor to end
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
        return (
            this.block.startPos === other.block.startPos &&
            this.block.endPos === other.block.endPos &&
            this.block.numColumns === other.block.numColumns &&
            this.block.colors.join('|') === other.block.colors.join('|') &&
            this.block.borders.join('|') === other.block.borders.join('|')
        );
    }

    ignoreEvent(): boolean {
        return true; // Let the widget handle its own events
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

        // Consume metadata lines from the beginning (order-independent, skipping blanks)
        let idx = 0;
        while (idx < blockLines.length) {
            const line = blockLines[idx].trim();
            if (!line) {
                idx += 1;
                continue;
            }

            const colorMatch = line.match(colorLineRe);
            if (colorMatch) {
                colors = colorMatch[1].split('|').map(c => c.trim());
                blockLines.splice(idx, 1);
                continue;
            }

            const borderMatch = line.match(borderLineRe);
            if (borderMatch) {
                borders = borderMatch[1].split('|').map(b => b.trim());
                blockLines.splice(idx, 1);
                continue;
            }

            // Hit a non-metadata line, stop consuming
            break;
        }

        // Parse remaining lines as column content
        const bodyText = blockLines.join('\n');
        const cols = parseColumnsFromBody(bodyText, num);

        blocks.push({
            numColumns: num,
            columns: cols,
            startPos,
            endPos,
            startMarkerLen,
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
 * Export the extension
 */
export function liveColumnsExtension() {
    return [columnsViewPlugin];
}