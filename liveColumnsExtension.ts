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
 * Partial block data for position matching (during update)
 */
interface PartialColumnsBlock {
    startPos: number;
    endPos: number;
    numColumns: number;
    colors: string[];
    borders: string[];
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
    private isEditing = false; // Track if any column is being edited
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

        // Click on container padding/gap to select it (for deletion)
        this.container.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            // Only focus container if clicking directly on it, not on columns
            if (target === this.container) {
                this.container.focus();
            }
        });

        // Add delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'live-columns-delete-btn';
        deleteBtn.textContent = '🗑️ delete';
        deleteBtn.title = 'Delete this column block';
        deleteBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.deleteEntireBlock();
        });
        this.container.appendChild(deleteBtn);

        return this.container;
    }

    /**
     * Delete the entire column block from the document
     */
    private deleteEntireBlock(): void {
        const doc = this.view.state.doc;
        const text = doc.toString();

        // Re-find block position (positions may have shifted)
        const startRe = /%%\s*columns:start\s+(\d+)\s*%{1,2}/gi;
        let match;
        let from = -1;
        let to = -1;
        let bestMatch = { from: -1, to: -1, distance: Infinity };

        while ((match = startRe.exec(text)) !== null) {
            const startPos = match.index;
            const num = parseInt(match[1], 10);
            
            // Check: numColumns must match
            if (num === this.block.numColumns) {
                // Calculate distance from expected position
                const distance = Math.abs(startPos - this.block.startPos);
                
                // Track the closest match
                if (distance < bestMatch.distance) {
                    bestMatch.distance = distance;
                    
                    // Find the end marker
                    const endRe = /%%\s*columns:end\s*%{1,2}/gi;
                    endRe.lastIndex = startRe.lastIndex;
                    const endMatch = endRe.exec(text);
                    if (endMatch) {
                        bestMatch.from = match.index;
                        bestMatch.to = endMatch.index + endMatch[0].length;
                    }
                }
            }
        }

        if (bestMatch.from === -1 || bestMatch.to === -1) {
            console.error('Live Columns: Could not find block to delete');
            return;
        }

        from = bestMatch.from;
        to = bestMatch.to;

        // Also delete trailing newline if present
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
        // Tell LaTeX Suite to ignore this element to avoid conflicts
        colDiv.setAttribute('data-latex-suite-ignore', 'true');
        colDiv.setAttribute('data-mt-ignore', 'true'); // Also ignore MathType

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
            this.isEditing = true;
        });

        // On BLUR: Switch back to rendered HTML and sync
        colDiv.addEventListener('blur', () => {
            // First extract the raw text the user typed
            let rawText = colDiv.innerText || '';
            
            // Expand LaTeX shortcuts
            rawText = this.expandLatexShortcuts(rawText);
            
            this.columnContents[index] = rawText.trim();

            // Then render it back to HTML
            this.setColumnContent(colDiv, this.columnContents[index], false);
            colDiv.classList.remove('live-column-editing');
            this.isEditing = false;

            // Sync to source document
            this.syncToSource();
        });

        // Sync on input with debounce to catch edits before any rebuild
        // FIXED: Only sync when not editing to avoid cursor jumping
        let inputTimeout: NodeJS.Timeout | null = null;
        colDiv.addEventListener('input', () => {
            // Update local state immediately
            const rawText = colDiv.innerText || '';
            this.columnContents[index] = rawText.trim();

            // Debounced sync to document - but skip if currently editing
            if (inputTimeout) clearTimeout(inputTimeout);
            inputTimeout = setTimeout(() => {
                // Only sync if not currently editing (user has stopped typing and left the column)
                if (!this.isEditing) {
                    this.syncToSource();
                }
            }, 300);
        });

        // Strip HTML formatting on paste - only keep plain text
        // This ensures pasted content uses column's CSS fonts
        colDiv.addEventListener('paste', (e) => {
            e.preventDefault();
            let text = e.clipboardData?.getData('text/plain') || '';

            // Expand LaTeX shortcuts on paste
            text = this.expandLatexShortcuts(text);

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

            // Update columnContents after paste
            setTimeout(() => {
                const rawText = colDiv.innerText || '';
                this.columnContents[index] = rawText.trim();
                this.syncToSource();
            }, 50);
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
            // RENDERED MODE: Build formatted nodes without parsing string markup.
            this.renderContent(colDiv, content);
        }
    }

    /**
     * Expand LaTeX shortcuts to Unicode symbols
     * Matches patterns like $times, \gamma, or $\gamma$ and converts to Unicode
     */
    private expandLatexShortcuts(text: string): string {
        if (!text) return text;
        
        // Common LaTeX shortcuts mapping
        // Format: [pattern, replacement]
        // Supports: $gamma, \gamma, $\gamma$
        const shortcuts: [RegExp, string][] = [
            // Greek letters - with backslash (e.g., \gamma)
            [/\\alpha/g, 'α'], [/\\Alpha/g, 'Α'], [/\\beta/g, 'β'], [/\\Beta/g, 'Β'],
            [/\\gamma/g, 'γ'], [/\\Gamma/g, 'Γ'], [/\\delta/g, 'δ'], [/\\Delta/g, 'Δ'],
            [/\\epsilon/g, 'ε'], [/\\varepsilon/g, 'ε'], [/\\zeta/g, 'ζ'], [/\\eta/g, 'η'], 
            [/\\theta/g, 'θ'], [/\\Theta/g, 'Θ'], [/\\vartheta/g, 'θ'],
            [/\\iota/g, 'ι'], [/\\kappa/g, 'κ'], [/\\lambda/g, 'λ'],
            [/\\Lambda/g, 'Λ'], [/\\mu/g, 'μ'], [/\\nu/g, 'ν'], [/\\xi/g, 'ξ'],
            [/\\Xi/g, 'Ξ'], [/\\pi/g, 'π'], [/\\varpi/g, 'π'], [/\\Pi/g, 'Π'], [/\\rho/g, 'ρ'],
            [/\\varrho/g, 'ρ'], [/\\sigma/g, 'σ'], [/\\Sigma/g, 'Σ'], [/\\varsigma/g, 'σ'],
            [/\\tau/g, 'τ'], [/\\upsilon/g, 'υ'], [/\\Upsilon/g, 'Υ'],
            [/\\phi/g, 'φ'], [/\\Phi/g, 'Φ'], [/\\varphi/g, 'φ'],
            [/\\chi/g, 'χ'], [/\\psi/g, 'ψ'], [/\\Psi/g, 'Ψ'], 
            [/\\omega/g, 'ω'], [/\\Omega/g, 'Ω'],
            
            // Greek letters - $ prefix (e.g., $gamma) - no backslash
            [/\$alpha/g, 'α'], [/\$Alpha/g, 'Α'], [/\$beta/g, 'β'], [/\$Beta/g, 'Β'],
            [/\$gamma/g, 'γ'], [/\$Gamma/g, 'Γ'], [/\$delta/g, 'δ'], [/\$Delta/g, 'Δ'],
            [/\$epsilon/g, 'ε'], [/\$zeta/g, 'ζ'], [/\$eta/g, 'η'], [/\$theta/g, 'θ'],
            [/\$Theta/g, 'Θ'], [/\$iota/g, 'ι'], [/\$kappa/g, 'κ'], [/\$lambda/g, 'λ'],
            [/\$Lambda/g, 'Λ'], [/\$mu/g, 'μ'], [/\$nu/g, 'ν'], [/\$xi/g, 'ξ'],
            [/\$Xi/g, 'Ξ'], [/\$pi/g, 'π'], [/\$Pi/g, 'Π'], [/\$rho/g, 'ρ'],
            [/\$sigma/g, 'σ'], [/\$Sigma/g, 'Σ'], [/\$tau/g, 'τ'], [/\$upsilon/g, 'υ'],
            [/\$phi/g, 'φ'], [/\$Phi/g, 'Φ'], [/\$chi/g, 'χ'], [/\$psi/g, 'ψ'],
            [/\$Psi/g, 'Ψ'], [/\$omega/g, 'ω'], [/\$Omega/g, 'Ω'],
            
            // Math operators
            [/\\times/g, '×'], [/\\div/g, '÷'], [/\\pm/g, '±'], [/\\mp/g, '∓'],
            [/\\cdot/g, '·'], [/\\ast/g, '∗'], [/\\star/g, '★'], [/\\circ/g, '∘'],
            [/\\bullet/g, '•'], [/\\oplus/g, '⊕'], [/\\ominus/g, '⊖'], [/\\otimes/g, '⊗'],
            [/\\oslash/g, '⊘'], [/\\odot/g, '⊙'],
            // $ prefix versions
            [/\$times/g, '×'], [/\$div/g, '÷'], [/\$pm/g, '±'], [/\$mp/g, '∓'],
            [/\$cdot/g, '·'], [/\$ast/g, '∗'], [/\$star/g, '★'], [/\$circ/g, '∘'],
            [/\$bullet/g, '•'], [/\$oplus/g, '⊕'], [/\$ominus/g, '⊖'], [/\$otimes/g, '⊗'],
            [/\$oslash/g, '⊘'], [/\$odot/g, '⊙'],
            
            // Relations
            [/\\leq/g, '≤'], [/\\leqslant/g, '≤'], [/\\geq/g, '≥'], [/\\geqslant/g, '≥'],
            [/\\neq/g, '≠'], [/\\ne/g, '≠'], [/\\approx/g, '≈'], [/\\equiv/g, '≡'],
            [/\\cong/g, '≅'], [/\\sim/g, '∼'], [/\\simeq/g, '≃'], [/\\subset/g, '⊂'],
            [/\\supset/g, '⊃'], [/\\subseteq/g, '⊆'], [/\\supseteq/g, '⊇'],
            [/\\in/g, '∈'], [/\\ni/g, '∋'], [/\\notin/g, '∉'],
            // $ prefix versions
            [/\$leq/g, '≤'], [/\$leqn/g, '⩽'], [/\$geq/g, '≥'], [/\$geqn/g, '⩾'],
            [/\$neq/g, '≠'], [/\$ne/g, '≠'], [/\$approx/g, '≈'], [/\$equiv/g, '≡'],
            [/\$cong/g, '≅'], [/\$sim/g, '∼'], [/\$simeq/g, '≃'], [/\$subset/g, '⊂'],
            [/\$supset/g, '⊃'], [/\$subseteq/g, '⊆'], [/\$supseteq/g, '⊇'],
            [/\$in/g, '∈'], [/\$ni/g, '∋'], [/\$notin/g, '∉'],
            
            // Arrows
            [/\\to/g, '→'], [/\\gets/g, '←'], [/\\rightarrow/g, '→'], [/\\leftarrow/g, '←'],
            [/\\Rightarrow/g, '⇒'], [/\\Leftarrow/g, '⇐'], [/\\leftrightarrow/g, '↔'],
            [/\\Updownarrow/g, '⇕'], [/\\mapsto/g, '↦'], [/\\hookleftarrow/g, '↪'],
            [/\\hookrightarrow/g, '↩'], [/\\nearrow/g, '↗'], [/\\searrow/g, '↘'],
            [/\\swarrow/g, '↙'], [/\\nwarrow/g, '↖'],
            // $ prefix versions
            [/\$to/g, '→'], [/\$gets/g, '←'], [/\$rightarrow/g, '→'], [/\$leftarrow/g, '←'],
            [/\$Rightarrow/g, '⇒'], [/\$Leftarrow/g, '⇐'], [/\$leftrightarrow/g, '↔'],
            [/\$Updownarrow/g, '⇕'], [/\$mapsto/g, '↦'], [/\$hookleftarrow/g, '↪'],
            [/\$hookrightarrow/g, '↩'], [/\$nearrow/g, '↗'], [/\$searrow/g, '↘'],
            [/\$swarrow/g, '↙'], [/\$nwarrow/g, '↖'],
            
            // Logic
            [/\\forall/g, '∀'], [/\\exists/g, '∃'], [/\\nexists/g, '∄'], [/\\neg/g, '¬'],
            [/\\land/g, '∧'], [/\\lor/g, '∨'], [/\\lnot/g, '¬'],
            // $ prefix versions
            [/\$forall/g, '∀'], [/\$exists/g, '∃'], [/\$nexists/g, '∄'], [/\$neg/g, '¬'],
            [/\$land/g, '∧'], [/\$lor/g, '∨'], [/\$lnot/g, '¬'],
            
            // Sets
            [/\\cap/g, '∩'], [/\\cup/g, '∪'], [/\\emptyset/g, '∅'], [/\\varnothing/g, '∅'],
            [/\\partial/g, '∂'],
            // $ prefix versions
            [/\$cap/g, '∩'], [/\$cup/g, '∪'], [/\$emptyset/g, '∅'], [/\$partial/g, '∂'],
            
            // Misc
            [/\\infty/g, '∞'], [/\\aleph/g, 'ℵ'], [/\\hbar/g, 'ℏ'], [/\\ell/g, 'ℓ'],
            [/\\wp/g, '℘'], [/\\Re/g, 'ℜ'], [/\\Im/g, 'ℑ'], [/\\angle/g, '∠'],
            [/\\triangle/g, '△'], [/\\square/g, '□'], [/\\diamond/g, '◇'],
            [/\\clubsuit/g, '♣'], [/\\diamondsuit/g, '♢'], [/\\heartsuit/g, '♡'],
            [/\\spadesuit/g, '♠'],
            // $ prefix versions
            [/\$infty/g, '∞'], [/\$aleph/g, 'ℵ'], [/\$hbar/g, 'ℏ'], [/\$ell/g, 'ℓ'],
            [/\$wp/g, '℘'], [/\$Re/g, 'ℜ'], [/\$Im/g, 'ℑ'], [/\$angle/g, '∠'],
            [/\$triangle/g, '△'], [/\$square/g, '□'], [/\$diamond/g, '◇'],
            [/\$clubsuit/g, '♣'], [/\$diamondsuit/g, '♢'], [/\$heartsuit/g, '♡'],
            [/\$spadesuit/g, '♠'],
            
            // Dots
            [/\\ldots/g, '…'], [/\\cdots/g, '⋯'], [/\\vdots/g, '⋮'], [/\\ddots/g, '⋱'],
            // $ prefix versions
            [/\$ldots/g, '…'], [/\$cdots/g, '⋯'], [/\$vdots/g, '⋮'], [/\$ddots/g, '⋱'],
            
            // Brackets
            [/\\langle/g, '⟨'], [/\\rangle/g, '⟩'], [/\\lceil/g, '⌈'], [/\\rceil/g, '⌉'],
            [/\\lfloor/g, '⌊'], [/\\rfloor/g, '⌋'],
            // $ prefix versions
            [/\$langle/g, '⟨'], [/\$rangle/g, '⟩'], [/\$lceil/g, '⌈'], [/\$rceil/g, '⌉'],
            [/\$lfloor/g, '⌊'], [/\$rfloor/g, '⌋'],
            
            // Currency
            [/\\cent/g, '¢'], [/\\-pound/g, '£'], [/\\yen/g, '¥'], [/\\euro/g, '€'],
            [/\\dollar/g, '$'], [/\\currency/g, '¤'],
            // $ prefix versions
            [/\$cent/g, '¢'], [/\$pound/g, '£'], [/\$yen/g, '¥'], [/\$euro/g, '€'],
            [/\$dollar/g, '$'], [/\$currency/g, '¤'],
            
            // Text
            [/\\degree/g, '°'], [/\\prime/g, '′'], [/\\dprime/g, '″'], [/\\ellipsis/g, '…'],
            // $ prefix versions
            [/\$degree/g, '°'], [/\$prime/g, '′'], [/\$dprime/g, '″'], [/\$ellipsis/g, '…'],
        ];

        let result = text;
        for (const [pattern, replacement] of shortcuts) {
            result = result.replace(pattern, replacement);
        }
        
        return result;
    }

    /**
     * Render markdown content directly into DOM nodes.
     */
    private renderContent(container: HTMLElement, text: string): void {
        if (!text.trim()) {
            container.appendChild(document.createElement('br'));
            return;
        }

        let activeList: HTMLUListElement | null = null;
        const closeList = () => {
            if (activeList) {
                container.appendChild(activeList);
                activeList = null;
            }
        };

        text.split('\n').forEach(line => {
            if (!line.trim()) {
                closeList();
                container.appendChild(document.createElement('br'));
                return;
            }

            const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
            if (headingMatch) {
                closeList();
                const heading = document.createElement(`h${headingMatch[1].length}`);
                this.appendInlineMarkdown(heading, headingMatch[2]);
                container.appendChild(heading);
                return;
            }

            const listMatch = line.match(/^[-*]\s+(.+)$/) || line.match(/^\d+\.\s+(.+)$/);
            if (listMatch) {
                if (!activeList) {
                    activeList = document.createElement('ul');
                }

                const item = document.createElement('li');
                this.appendInlineMarkdown(item, listMatch[1]);
                activeList.appendChild(item);
                return;
            }

            closeList();
            const div = document.createElement('div');
            this.appendInlineMarkdown(div, line);
            container.appendChild(div);
        });

        closeList();
    }

    private appendInlineMarkdown(parent: HTMLElement, text: string): void {
        const tokenRe = /(\*\*([^*]+?)\*\*|\*([^*]+?)\*|`([^`]+?)`|\[([^\]]+)\]\(([^)]+)\))/g;
        let lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = tokenRe.exec(text)) !== null) {
            if (match.index > lastIndex) {
                parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
            }

            if (match[2] !== undefined) {
                const strong = document.createElement('strong');
                strong.textContent = match[2];
                parent.appendChild(strong);
            } else if (match[3] !== undefined) {
                const em = document.createElement('em');
                em.textContent = match[3];
                parent.appendChild(em);
            } else if (match[4] !== undefined) {
                const code = document.createElement('code');
                code.textContent = match[4];
                parent.appendChild(code);
            } else if (match[5] !== undefined && match[6] !== undefined) {
                const safeHref = this.sanitizeHref(match[6]);
                if (safeHref) {
                    const link = document.createElement('a');
                    link.textContent = match[5];
                    link.setAttribute('href', safeHref);
                    parent.appendChild(link);
                } else {
                    parent.appendChild(document.createTextNode(match[5]));
                }
            }

            lastIndex = tokenRe.lastIndex;
        }

        if (lastIndex < text.length) {
            parent.appendChild(document.createTextNode(text.slice(lastIndex)));
        }
    }

    private sanitizeHref(href: string): string | null {
        const trimmed = href.trim();
        if (/^(javascript|data|vbscript):/i.test(trimmed)) {
            return null;
        }

        return trimmed;
    }

    /**
     * Extract plain text/markdown from HTML
     * FIXED: Improved logic to handle div/br combinations without adding extra lines
     */
    private extractContent(el: HTMLElement): string {
        const text = Array.from(el.childNodes)
            .map(node => this.markdownFromNode(node))
            .join('');

        return this.normalizeExtractedMarkdown(text);
    }

    private markdownFromNode(node: Node): string {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent || '';
        }

        if (!(node instanceof HTMLElement)) {
            return '';
        }

        const tagName = node.tagName.toLowerCase();
        const childMarkdown = () => Array.from(node.childNodes)
            .map(child => this.markdownFromNode(child))
            .join('');

        if (/^h[1-6]$/.test(tagName)) {
            const level = Number(tagName.slice(1));
            return `${'#'.repeat(level)} ${childMarkdown().trim()}\n`;
        }

        if (tagName === 'strong' || tagName === 'b') {
            return `**${childMarkdown()}**`;
        }

        if (tagName === 'em' || tagName === 'i') {
            return `*${childMarkdown()}*`;
        }

        if (tagName === 'code') {
            return `\`${node.textContent || ''}\``;
        }

        if (tagName === 'a') {
            const href = node.getAttribute('href') || '';
            return `[${childMarkdown()}](${href})`;
        }

        if (tagName === 'li') {
            return `- ${childMarkdown().trim()}\n`;
        }

        if (tagName === 'ul' || tagName === 'ol') {
            return childMarkdown();
        }

        if (tagName === 'div' || tagName === 'p') {
            return `${childMarkdown()}\n`;
        }

        if (tagName === 'br') {
            return '\n';
        }

        return childMarkdown();
    }

    private normalizeExtractedMarkdown(text: string): string {
        return text
            .replace(/\u00a0/g, ' ')
            .replace(/^\n+/, '')
            .replace(/\n+$/, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    private syncToSource() {
        if (this.isUpdating || !this.container) return;
        this.isUpdating = true;

        try {
            const newContents: string[] = [];
            const columns = this.container.querySelectorAll('.live-column');

            // Get the actual number of columns in the DOM (not the original block number)
            const actualColumnCount = columns.length;

            columns.forEach((col) => {
                const content = this.extractContent(col as HTMLElement);
                newContents.push(content);
            });

            // Check if anything actually changed to avoid unnecessary updates.
            // Compare against the content currently persisted in the document, NOT
            // against this.columnContents: the latter is kept in sync with the DOM
            // by the `input`/`blur` handlers, so it would always match newContents
            // here and the write would be skipped, meaning edits were never saved.
            let persistedColumns: string[] | null = null;
            let persistedDistance = Infinity;
            for (const b of findColumnsBlocks(this.view)) {
                const d = Math.abs(b.startPos - this.block.startPos);
                if (d < persistedDistance) {
                    persistedDistance = d;
                    persistedColumns = b.columns;
                }
            }
            const hasChanges = !persistedColumns
                || newContents.length !== persistedColumns.length
                || newContents.some((content, i) =>
                    (content || '') !== (persistedColumns![i] || '')
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

            // Find the closest block by position - this is the most reliable method
            // because we might have changed the number of columns
            let bestMatchByPosition: PartialColumnsBlock | null = null;
            let bestPositionDistance = Infinity;

            while ((match = startRe.exec(text)) !== null) {
                const startPos = match.index;
                const num = parseInt(match[1], 10);
                
                // Calculate distance from expected position
                const distance = Math.abs(startPos - this.block.startPos);
                
                if (distance < bestPositionDistance) {
                    bestPositionDistance = distance;
                    
                    const endRe = /%%\s*columns:end\s*%{1,2}/gi;
                    endRe.lastIndex = startRe.lastIndex;
                    const endMatch = endRe.exec(text);
                    
                    if (endMatch) {
                        const endPos = endMatch.index + endMatch[0].length;
                        const blockContent = text.slice(startRe.lastIndex, endMatch.index);
                        const colorLineRe = /%%\s*columns:colors\s+([^\n%]+)\s*%{1,2}/i;
                        const borderLineRe = /%%\s*columns:borders\s+([^\n%]+)\s*%{1,2}/i;

                        const colorMatch = blockContent.match(colorLineRe);
                        const borderMatch = blockContent.match(borderLineRe);

                        bestMatchByPosition = {
                            startPos,
                            endPos,
                            numColumns: num,
                            colors: colorMatch ? colorMatch[1].split('|').map(c => c.trim()) : [],
                            borders: borderMatch ? borderMatch[1].split('|').map(b => b.trim()) : []
                        };
                    }
                }
            }

            // Use the closest block by position (with generous tolerance)
            // This handles cases where columns were deleted or added
            if (bestMatchByPosition && bestPositionDistance < 200) {
                currentBlock = bestMatchByPosition;
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

            // Use actual column count from DOM, not the original block numColumns
            const newMarkdown = buildColumnsMarkdown(
                actualColumnCount,
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

                const hideLine = Decoration.line({ class: 'live-columns-line-hidden' });
                const hideInline = Decoration.mark({ class: 'live-columns-inline-hidden', inclusive: false });

                for (const block of blocks) {
                    const doc = view.state.doc;
                    // Clamp decoration range to valid document bounds
                    const docLength = doc.length;
                    const from = Math.max(0, Math.min(block.startPos, docLength));
                    const to = Math.max(from, Math.min(block.endPos, docLength));
                    if (from === to) continue;

                    // Add widget at block start (rendered as block via CSS, but not a block decoration)
                    const widget = Decoration.widget({
                        widget: new ColumnsWidget(block, view),
                        // keep inline to satisfy Obsidian CM6 restriction
                        block: false
                    });

                    builder.add(from, from, widget);

                    // Hide marker text on the first line (keep widget visible)
                    const startLine = doc.lineAt(from);
                    if (startLine.to > from) {
                        builder.add(from, startLine.to, hideInline);
                    }

                    // Hide every subsequent source line in this block (including colors/borders/body/end marker)
                    const endLineNumber = doc.lineAt(to).number;
                    for (let ln = startLine.number + 1; ln <= endLineNumber; ln++) {
                        const line = doc.line(ln);
                        builder.add(line.from, line.from, hideLine);
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
    changes.iterChanges((fromA, _toA) => {
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
