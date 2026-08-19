// Port of the `INodeProvider` trio at the head of Signum.Word's WordTemplateNodes.cs.
//
// The three OOXML dialects express "a styled run of text inside a paragraph" with different element names
// in different namespaces:
//
//                  paragraph        run       text      run properties     line break
//   Wordprocessing   w:p            w:r       w:t          w:rPr              w:br
//   DrawingML        a:p            a:r       a:t          a:rPr              a:br
//   Spreadsheet     (none)          s:r*      s:t          s:rPr              s:br
//
//   * a spreadsheet's rich text lives in an `is`/`si` container, not a paragraph — which is why
//     `isParagraph` is always false for it and it is the only provider that implements `wrapInRun`.
//
// The parser is written ONCE against this interface and dispatches per element, so .docx, .pptx and .xlsx
// all flow through the same token-matching code. Signum discriminates with `is W.Run` / `is D.Run` type
// tests against the SDK's generated classes; altea has no generated classes, so each provider matches on
// the QUALIFIED ELEMENT NAME instead — the prefix is stable per part (declared once on the root and never
// rebound), which is exactly the assumption OOXML itself makes.

import { OxmlElement, OxmlText, type OxmlNode, type SpaceProcessingMode } from "./oxml/OxmlElement.server";

export interface INodeProvider {
    /** A bare text element carrying `text` (`w:t` / `a:t` / `s:t`). */
    newText(text: string): OxmlElement;

    /** A run wrapping `text`, optionally carrying a clone of `runProps` and a leading line break. */
    newRun(runProps: OxmlElement | undefined, text: string | undefined, spaceMode?: SpaceProcessingMode, initialBr?: boolean): OxmlElement;

    /**
     * The nodes that render `text` preceded by a line break. Wordprocessing and Spreadsheet put the break
     * INSIDE the run; DrawingML requires `a:br` to be a paragraph-level SIBLING of `a:r`, so that provider
     * returns two nodes. Signum's comment on the Drawing implementation says exactly this.
     */
    newRunWithLeadingBreak(runProps: OxmlElement | undefined, text: string | undefined, spaceMode?: SpaceProcessingMode): OxmlNode[];

    isRun(element: OxmlNode | undefined): boolean;
    isText(element: OxmlNode | undefined): boolean;

    /** The text carried by a run (or by a text element directly). "" when it carries none. */
    getText(run: OxmlNode): string;

    /** Signum's `CastRun` — narrow to the run element, throwing when it is not one. */
    castRun(element: OxmlNode): OxmlElement;

    /** A run's properties child, or undefined when it has none. */
    getRunProperties(run: OxmlElement): OxmlElement | undefined;

    isParagraph(element: OxmlNode | undefined): boolean;
    isRunProperties(element: OxmlNode | undefined): boolean;

    /** Wrap a bare text element in a run. Only meaningful for spreadsheets (see the header). */
    wrapInRun(text: OxmlElement): OxmlElement;
}

/** Shared implementation: the three dialects differ only in their element names. */
abstract class NodeProviderBase implements INodeProvider {
    protected abstract readonly paragraphName: string | undefined;
    protected abstract readonly runName: string;
    protected abstract readonly textName: string;
    protected abstract readonly runPropertiesName: string;
    protected abstract readonly breakName: string;

    newText(text: string): OxmlElement {
        const e = new OxmlElement(this.textName);
        e.appendChild(new OxmlText(text));
        return e;
    }

    newRun(runProps: OxmlElement | undefined, text: string | undefined, spaceMode?: SpaceProcessingMode, initialBr = false): OxmlElement {
        const textNode = this.newText(text ?? "");
        if (spaceMode != null)
            textNode.space = spaceMode;

        const run = new OxmlElement(this.runName);
        // Run properties MUST come first in every dialect's content model.
        if (runProps != null)
            run.appendChild(runProps);
        if (initialBr)
            run.appendChild(new OxmlElement(this.breakName));
        run.appendChild(textNode);
        return run;
    }

    newRunWithLeadingBreak(runProps: OxmlElement | undefined, text: string | undefined, spaceMode?: SpaceProcessingMode): OxmlNode[] {
        return [this.newRun(runProps, text, spaceMode, true)];
    }

    isRun(element: OxmlNode | undefined): boolean {
        return element instanceof OxmlElement && element.qualifiedName === this.runName;
    }

    isText(element: OxmlNode | undefined): boolean {
        return element instanceof OxmlElement && element.qualifiedName === this.textName;
    }

    getText(run: OxmlNode): string {
        if (!(run instanceof OxmlElement))
            return "";
        if (run.qualifiedName === this.textName)
            return run.innerText;
        // Signum takes SingleOrDefault: a run carries at most one text element.
        const t = run.element(this.textName);
        return t?.innerText ?? "";
    }

    castRun(element: OxmlNode): OxmlElement {
        if (!this.isRun(element))
            throw new Error(`Expected a ${this.runName}, found ${element instanceof OxmlElement ? element.qualifiedName : typeof element}`);
        return element as OxmlElement;
    }

    getRunProperties(run: OxmlElement): OxmlElement | undefined {
        return run.element(this.runPropertiesName);
    }

    isParagraph(element: OxmlNode | undefined): boolean {
        return this.paragraphName != null
            && element instanceof OxmlElement && element.qualifiedName === this.paragraphName;
    }

    isRunProperties(element: OxmlNode | undefined): boolean {
        return element instanceof OxmlElement && element.qualifiedName === this.runPropertiesName;
    }

    wrapInRun(_text: OxmlElement): OxmlElement {
        // Signum throws NotImplementedException here for Wordprocessing and DrawingML: only a spreadsheet's
        // inline string ever holds a NAKED text element that has to be promoted into a run.
        throw new Error(`wrapInRun is not supported for ${this.runName}`);
    }
}

/** `.docx` body text — WordprocessingML (Signum's WordprocessingNodeProvider). */
export class WordprocessingNodeProvider extends NodeProviderBase {
    protected override readonly paragraphName = "w:p";
    protected override readonly runName = "w:r";
    protected override readonly textName = "w:t";
    protected override readonly runPropertiesName = "w:rPr";
    protected override readonly breakName = "w:br";
}

/** Text inside a shape / chart / slide — DrawingML (Signum's DrawingNodeProvider). Used by `.pptx`. */
export class DrawingNodeProvider extends NodeProviderBase {
    protected override readonly paragraphName = "a:p";
    protected override readonly runName = "a:r";
    protected override readonly textName = "a:t";
    protected override readonly runPropertiesName = "a:rPr";
    protected override readonly breakName = "a:br";

    /**
     * DrawingML forbids `a:br` inside `a:r` — the break is a sibling at paragraph level. Signum clones the
     * run properties onto the break so the blank line keeps the run's font metrics.
     */
    override newRunWithLeadingBreak(runProps: OxmlElement | undefined, text: string | undefined, spaceMode?: SpaceProcessingMode): OxmlNode[] {
        const br = new OxmlElement(this.breakName);
        if (runProps != null)
            br.appendChild(runProps.cloneNode(true));
        return [br, this.newRun(runProps, text, spaceMode)];
    }
}

/** `.xlsx` rich text inside an inline / shared string (Signum's SpreadsheetNodeProvider). */
export class SpreadsheetNodeProvider extends NodeProviderBase {
    // A spreadsheet's rich text has no paragraph level at all — Signum returns false unconditionally.
    protected override readonly paragraphName = undefined;
    protected override readonly runName = "r";
    protected override readonly textName = "t";
    protected override readonly runPropertiesName = "rPr";
    protected override readonly breakName = "br";

    /** An inline string may hold a bare `<t>`; promoting it into a `<r>` is how the parser normalises it. */
    override wrapInRun(text: OxmlElement): OxmlElement {
        const run = new OxmlElement(this.runName);
        run.appendChild(text);
        return run;
    }
}
