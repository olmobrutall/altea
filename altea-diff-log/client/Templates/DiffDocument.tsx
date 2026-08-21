import * as React from "react";
import { type Change, diffLines, diffWords } from "diff";
import { NumberBox, isNumberKey } from "@altea/altea/client/Lines/NumberLine";
import { toNumberFormat } from "@altea/altea/client/numberFormat";
import { DiffLogMessage } from "../../data/DiffLog";
import "./DiffLog.css";

// Port of Signum.DiffLog's Templates/DiffDocument.tsx — a line diff that falls back to a WORD diff whenever a
// single line was replaced by a single line, so a one-word change reads as a one-word change. Collapses runs
// of unchanged lines to "----- N lines removed -----" beyond a margin.
//
// It is the module's most reusable piece: @altea/altea-agent's SkillCustomization editor uses it to diff a
// customized instruction against the skill's code default.
//
// altea divergences, documented inline:
//  - `LinkButton` → a plain bootstrap link button (altea has no LinkButton).
//  - the three hardcoded English strings become DiffLogMessage keys (see data/DiffLog.ts), so the control is
//    translatable like the rest of the module. Signum writes the margin label as two literals AROUND the
//    NumberBox ("Show only" … "lines arround each change"); the message has a `{0}` placeholder instead and
//    the box is rendered AT it, so a translation can put the number where its own grammar wants it.
//  - `Array.range` / `.last()` / `.removeAt()` / `softCast` are spelled out — altea's globals carry some of
//    these, but the loop reads clearer without them.

export interface LineOrWordsChange {
    lineChange: Change;
    wordChanges?: Change[];
}

export function DiffDocument(p: { first: string; second: string }): React.JSX.Element {

    const [margin, setMargin] = React.useState<number | null>(DiffDocument.Options.defaultMarginLines);
    const [force, setForce] = React.useState(false);
    const formatter = toNumberFormat("N0");

    const tooBig = p.first.length > DiffDocument.Options.maxSize || p.second.length > DiffDocument.Options.maxSize;

    // The NumberBox goes WHERE the message's {0} is, so the two halves are the text around it.
    const [marginLabelBefore, marginLabelAfter] =
        splitAtPlaceholder(DiffLogMessage.ShowOnly0LinesAroundEachChange.niceToString());

    return (
        <div>
            <div>
                <label>
                    <input type="checkbox" className="form-check-input"
                        checked={margin != null}
                        onChange={() => setMargin(margin == null ? DiffDocument.Options.defaultMarginLines : null)} />
                    <span className="mx-2">{marginLabelBefore}</span>
                    <NumberBox format={toNumberFormat("0")}
                        value={margin ?? DiffDocument.Options.defaultMarginLines ?? 0}
                        // `onChange` hands back `number | Decimal` (altea's NumberBox serves both); a line
                        // count is always the number branch.
                        onChange={num => setMargin(num == null ? 0 : Math.max(Number(num), 0))}
                        validateKey={isNumberKey} />
                    <span className="mx-2">{marginLabelAfter}</span>
                </label>
            </div>
            <div>
                {tooBig && !force
                    ? <div className="alert alert-warning mt-2" role="alert">
                        {DiffLogMessage.TheTwoStringsAreTooBig01AndCouldFreezeYourBrowser.niceToString(
                            `${formatter.format(p.first.length)} ch.`, `${formatter.format(p.second.length)} ch.`)}
                        <br />
                        <button type="button" className="btn btn-sm btn-warning mt-3" onClick={() => setForce(true)}>
                            {DiffLogMessage.TryAnyway.niceToString()}
                        </button>
                    </div>
                    : <DiffDocumentSimple first={p.first} second={p.second} margin={margin} />}
            </div>
        </div>
    );
}

/** Split a message template at its {0}, so a control can be rendered in the placeholder's place. */
function splitAtPlaceholder(template: string): [string, string] {
    const at = template.indexOf("{0}");
    return at < 0 ? [template, ""] : [template.slice(0, at).trimEnd(), template.slice(at + 3).trimStart()];
}

export namespace DiffDocument {
    export const Options = {
        defaultMarginLines: 4 as number | null,
        maxSize: 300_000,
    };
}

export function DiffDocumentSimple(p: { first: string; second: string; margin?: number | null }): React.JSX.Element {

    const linesDiff = React.useMemo<LineOrWordsChange[]>(() => {
        const diffs = diffLines(p.first, p.second);
        const result: LineOrWordsChange[] = [];

        for (let i = 0; i < diffs.length; i++) {
            const change = diffs[i]!;

            // One line out, one line in: diff the WORDS so the row highlights only what moved.
            const nextChange = diffs[i + 1];
            if (change.removed && change.count === 1 && nextChange?.added && nextChange.count === 1) {
                const wordDiffs = diffWords(change.value, nextChange.value);
                result.push({ lineChange: change, wordChanges: wordDiffs.filter(c => !c.added) });
                result.push({ lineChange: nextChange, wordChanges: wordDiffs.filter(c => !c.removed) });
                i++;
                continue;
            }

            const lines = change.value.replace(/\r/g, "").split("\n");
            if (lines[lines.length - 1] === "")
                lines.pop();

            for (const line of lines)
                result.push({ lineChange: { value: line + "\n", count: 1, added: change.added, removed: change.removed } });
        }

        return result;
    }, [p.first, p.second]);

    const indices = p.margin == null
        ? linesDiff.map((_, i) => i)
        : expandNumbers(
            linesDiff.map((a, i) => a.lineChange.added || a.lineChange.removed ? i : null).filter((n): n is number => n != null),
            linesDiff.length,
            p.margin);

    return (
        <pre className="m-0">{indices.map((ix, i) => {
            if (typeof ix === "object")
                return (
                    <span key={i} style={{ backgroundColor: "var(--sf-diff-info)" }}>
                        <span>{DiffLogMessage._0LinesRemoved.niceToString(ix.numLines)}</span><br />
                    </span>
                );

            const line = linesDiff[ix]!;

            const color =
                line.lineChange.added ? "var(--sf-diff-added-light)" :
                    line.lineChange.removed ? "var(--sf-diff-removed-light)" : undefined;

            if (line.wordChanges) {
                return (
                    <span key={i} style={{ backgroundColor: color }}>
                        {line.wordChanges.map((c, j) => {
                            const changeColor = c.added ? "var(--sf-diff-added)" : c.removed ? "var(--sf-diff-removed)" : undefined;
                            return <span key={j} style={{ backgroundColor: changeColor }}>{c.value}</span>;
                        })}
                    </span>
                );
            }

            return <span key={i} style={{ backgroundColor: color }}>{line.lineChange.value}</span>;
        })}
        </pre>
    );
}

interface LinesRemoved {
    numLines: number;
}

/**
 * Signum's `expandNumbers` — turn the indices of the CHANGED lines into the full list to render: each change
 * plus `margin` lines of context, with a `LinesRemoved` marker standing in for every collapsed run.
 */
export function expandNumbers(changes: number[], max: number, margin: number): (number | LinesRemoved)[] {

    if (changes.length === 0)
        return [];

    const result: (number | LinesRemoved)[] = [];
    let lastChange = changes[0]!;

    const pushRange = (from: number, to: number): void => {
        for (let j = from; j <= to; j++)
            result.push(j);
    };

    const prev0 = lastChange - margin;
    if (prev0 <= 0) {
        pushRange(0, lastChange);
    } else {
        result.push({ numLines: prev0 });
        pushRange(prev0, lastChange);
    }

    for (let i = 1; i < changes.length; i++) {
        const nextLastChange = lastChange + margin;
        const newChange = changes[i]!;
        const prevNewChange = newChange - margin;

        if (nextLastChange + 1 < prevNewChange) {
            pushRange(lastChange + 1, nextLastChange);
            result.push({ numLines: prevNewChange - nextLastChange });
            pushRange(prevNewChange, newChange);
        } else {
            pushRange(lastChange + 1, newChange);
        }
        lastChange = newChange;
    }

    const nextN = lastChange + margin;
    if (nextN < max) {
        pushRange(lastChange + 1, nextN);
        result.push({ numLines: max - nextN });
    } else {
        pushRange(lastChange + 1, max - 1);
    }

    return result;
}
