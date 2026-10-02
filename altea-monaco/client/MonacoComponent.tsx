import * as React from "react";
import { loadMonaco, type Monaco } from "./monaco";
import "./Monaco.css";

// The one editor host every language wrapper renders — the Monaco counterpart of altea-codemirror's
// CodeMirrorComponent, and NEW in altea (Signum's editors are CodeMirror throughout).
//
// The reason to have it at all is the TYPE CHECKER. CodeMirror highlights TypeScript; it cannot tell you
// that `e.shipNme` is a typo, because it has no idea what `e` is. Monaco carries the real compiler, so a
// stored script can be authored against the same declarations the server compiles it against — which is
// what the rest of @altea/altea-eval exists to supply.
//
// THE ONE THING THIS DOES THAT A PLAIN EDITOR DOES NOT: it shows a FRAGMENT IN CONTEXT. A stored script is
// a function BODY, and a body alone type-checks against nothing — the parameters are declared by a
// signature the author never sees, and the names in scope come from imports the compiler writes. So the
// model holds the whole generated module, `header` and `footer` are banded and refuse edits, and only
// what lies between them is reported back as the value.
//
// Guarding by INVARIANT rather than by intercepting edits: after any change the text must still start with
// the header and end with the footer. Monaco has no read-only RANGE, and every scheme built out of key
// handlers leaks (paste, drag, multi-cursor, a code action), while this one cannot: whatever route an edit
// took, it is caught.
//
// Caught, and then CLIPPED rather than refused — an edit that merely spanned the fences is re-applied to
// the body alone. Select everything and paste, and the script is replaced inside a wrapper that survives.

export interface MonacoProps {
    /** The editable text — the only part `onChange` reports and the only part the user can touch. */
    value: string;
    onChange?: (value: string) => void;
    /** Fixed text shown ABOVE the editable region, dimmed and uneditable. */
    header?: string;
    /** Fixed text shown BELOW it, same. */
    footer?: string;
    language?: string;
    readOnly?: boolean;
    /** CSS height. A number is pixels; the default grows with the content up to a point. */
    height?: number | string;
    /**
     * The model's file name. Distinct per editor, so the TypeScript worker keeps two scripts apart — two
     * models on one path share a program and redeclare each other's symbols.
     */
    path?: string;
    /** Problems to mark, in the EDITABLE region's own line numbers (1 = the script's first line). */
    markers?: readonly MonacoMarker[];
    /**
     * False for a FRAGMENT: an expression body, a view's code, anything written against declarations the
     * editor was never given. The language service would report every identifier in it as undefined, which
     * is noise, not help.
     *
     * Suppressed per MODEL rather than by turning semantic validation off, because that switch is global to
     * the language service: the eval editor needs it ON, and in a single-page application the two outlive
     * each other. So the service keeps running — highlighting and completion are untouched — and everything
     * it PUBLISHES for this model is dropped.
     *
     * Everything, not only the semantic half: a fragment is a function BODY, so its `return` is a top-level
     * return as far as the service is concerned, and reporting that is no more useful than reporting the
     * identifiers. Markers this component is handed (`markers`) are its own and are left alone.
     */
    semanticDiagnostics?: boolean;
    /**
     * Shown on hover over the uneditable region. Supplied by the caller rather than written here,
     * because this package carries no translations of its own.
     */
    fenceHint?: string;
    /** Run once the editor exists, for anything this component does not wrap. */
    onMount?: (editor: MonacoEditor, monaco: Monaco) => void;
}

export interface MonacoMarker {
    line: number;
    message: string;
    severity?: "error" | "warning";
}

export type MonacoEditor = import("monaco-editor").editor.IStandaloneCodeEditor;

export function MonacoComponent(p: MonacoProps): React.JSX.Element {
    const container = React.useRef<HTMLDivElement>(null);
    const [monaco, setMonaco] = React.useState<Monaco | null>(null);
    const editorRef = React.useRef<MonacoEditor | null>(null);
    const isDark = useBootstrapTheme();

    // The props the Monaco callbacks read. They are registered once, against an editor that outlives any
    // one render, so they must not close over a stale render's props.
    const latest = React.useRef(p);
    latest.current = p;

    React.useEffect(() => { void loadMonaco().then(setMonaco); }, []);

    React.useEffect(() => {
        if (monaco == null || container.current == null)
            return;

        const { header, footer } = fences(latest.current);
        const uri = monaco.Uri.parse(latest.current.path ?? `inmemory://altea/${nextModelId++}.ts`);
        const model = monaco.editor.createModel(header + latest.current.value + footer,
            latest.current.language ?? "typescript", uri);

        const editor = monaco.editor.create(container.current, {
            model,
            readOnly: latest.current.readOnly,
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            lineNumbersMinChars: 3,
            folding: false,
            fontSize: 13,
            renderLineHighlight: "none",
            scrollbar: { alwaysConsumeMouseWheel: false },
            tabSize: 4,
            // The suggest list, the hover and the parameter hints are TALLER than these editors are:
            // a script is a handful of lines, and a completion list is ten. Left inside the editor they
            // are cut off at its bottom edge — by its own height, and by the `overflow: hidden` the host
            // needs for its rounded corners. So they are rendered OUT of it, into a container of their
            // own at the end of the document, where nothing clips them.
            fixedOverflowWidgets: true,
            overflowWidgetsDomNode: overflowWidgets(),
        });
        editorRef.current = editor;

        // ---- The guard ---------------------------------------------------------------------------------
        //
        // The last text that satisfied the invariant. Held because repairing a bad edit means knowing what
        // the document looked like BEFORE it — and a change reports its position as an offset into exactly
        // that text, which makes the repair string arithmetic rather than range arithmetic.
        //
        // Monaco's own `undo` was the obvious tool and the wrong one: it is a COMMAND, so the editor
        // re-asserts its cursor afterwards (every character after the first then landed back in the fence),
        // and a second undo walks over the repair the first one made.
        let guarding = false;
        let lastGood = model.getValue();

        const subscription = model.onDidChangeContent(e => {
            if (guarding)
                return;

            const text = model.getValue();
            const { header, footer } = fences(latest.current);

            if (text.startsWith(header) && text.endsWith(footer)) {
                lastGood = text;
                latest.current.onChange?.(text.slice(header.length, text.length - footer.length));
                return;
            }

            // The edit reached outside the editable region. Rather than refuse it — which made the most
            // ordinary gesture in an editor, select everything and type, appear to do nothing — it is
            // re-applied with its ENDS PULLED INSIDE the body. Select all and paste, and the script is
            // replaced while the wrapper around it survives.
            //
            // Several changes at once (multi-cursor) are not repaired this way: the intent is too ambiguous
            // to guess at, so the last good text simply stands.
            const change = e.changes.length === 1 ? e.changes[0] : undefined;
            const first = header.length;
            const last = lastGood.length - footer.length;
            const clip = (offset: number): number => Math.min(Math.max(offset, first), last);

            const repaired = change == null ? lastGood
                : lastGood.slice(0, clip(change.rangeOffset))
                + change.text
                + lastGood.slice(clip(change.rangeOffset + change.rangeLength));

            const caret = change == null ? first : clip(change.rangeOffset) + change.text.length;
            const before = repaired.slice(0, caret);
            const line = before.split("\n").length;
            const column = before.length - before.lastIndexOf("\n");

            // Applied through the EDITOR, not the model, because the caret has to move with the repair and
            // only the editor owns the caret. A model-level edit leaves the editor to re-assert the
            // selection the edit started from, which is inside the fence — every character after the first
            // then landed back at the top of the body, and typing a word in produced it backwards.
            //
            // And applied AFTER this event, because an editor edit from inside the model's own change
            // notification is re-entrant: Monaco is midway through updating its cursor and throws
            // ("Cannot read properties of null (reading 'isEmpty')"). `guarding` is raised now and lowered
            // there, so nothing in between is mistaken for the author's work.
            guarding = true;
            queueMicrotask(() => {
                editor.executeEdits("altea-monaco",
                    [{ range: model.getFullModelRange(), text: repaired, forceMoveMarkers: true }],
                    [new monaco.Selection(line, column, line, column)]);
                guarding = false;

                lastGood = repaired;
                latest.current.onChange?.(repaired.slice(header.length, repaired.length - footer.length));
            });
        });

        latest.current.onMount?.(editor, monaco);

        return () => {
            subscription.dispose();
            editor.dispose();
            model.dispose();
            editorRef.current = null;
        };
        // Built once: everything that changes afterwards is pushed in by the effects below, because
        // rebuilding would lose the cursor, the undo stack and the worker's warm program.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [monaco]);

    // The value changing UNDERNEATH the editor — a different entity loaded into the same line, an undo at
    // the form level. Skipped when the text already matches, or typing would fight the round trip.
    React.useEffect(() => {
        const editor = editorRef.current;
        if (monaco == null || editor == null)
            return;

        const model = editor.getModel();
        const { header, footer } = fences(p);
        const next = header + p.value + footer;
        if (model == null || model.getValue() === next)
            return;

        // `pushEditOperations` rather than `setValue`, so the undo stack survives.
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: next }], () => null);
    }, [monaco, p.value, p.header, p.footer]);

    React.useEffect(() => {
        editorRef.current?.updateOptions({ readOnly: p.readOnly });
    }, [p.readOnly]);

    React.useEffect(() => {
        monaco?.editor.setTheme(isDark ? "vs-dark" : "vs");
    }, [monaco, isDark]);

    // Dim what cannot be edited, so "why will it not let me type here" never has to be asked.
    React.useEffect(() => {
        const editor = editorRef.current;
        const model = editor?.getModel();
        if (monaco == null || model == null)
            return;

        const headerLines = lineCount(p.header);
        const footerLines = lineCount(p.footer);
        const total = model.getLineCount();
        const fenced = (from: number, to: number): import("monaco-editor").editor.IModelDeltaDecoration => ({
            range: new monaco.Range(from, 1, to, 1),
            options: {
                isWholeLine: true,
                className: "altea-monaco-fence",
                // The GUTTER too, so the band runs the full width of the editor. A line that is merely
                // fainter reads as faint text; a line on a different ground reads as a different kind of
                // thing, which is what it is.
                marginClassName: "altea-monaco-fence-margin",
                hoverMessage: p.fenceHint == null ? undefined : { value: p.fenceHint },
            },
        });

        const decorations = [
            ...(headerLines > 0 ? [fenced(1, headerLines)] : []),
            ...(footerLines > 0 ? [fenced(total - footerLines + 1, total)] : []),
        ];
        const collection = editor!.createDecorationsCollection(decorations);
        return () => collection.clear();
    }, [monaco, p.header, p.footer, p.value, p.fenceHint]);

    // A fragment's own language service has nothing to check it against — see `semanticDiagnostics`.
    React.useEffect(() => {
        const model = editorRef.current?.getModel();
        if (monaco == null || model == null || p.semanticDiagnostics !== false)
            return;

        const drop = (): void => {
            // Everything the SERVICE published, cleared owner by owner. Ours (`altea`) is left alone, and
            // clearing an owner that has nothing publishes no further change, so this settles immediately.
            const owners = new Set(monaco.editor.getModelMarkers({ resource: model.uri })
                .map(m => m.owner).filter(o => o !== MARKER_OWNER));
            for (const owner of owners)
                monaco.editor.setModelMarkers(model, owner, []);
        };

        drop();
        const subscription = monaco.editor.onDidChangeMarkers(uris => {
            if (uris.some(u => u.toString() === model.uri.toString()))
                drop();
        });
        return () => subscription.dispose();
    }, [monaco, p.semanticDiagnostics]);

    // Compile errors come back in the SCRIPT's line numbers (the server subtracts the generated wrapper
    // before reporting), so they are shifted back down onto the model here.
    React.useEffect(() => {
        const model = editorRef.current?.getModel();
        if (monaco == null || model == null)
            return;

        const offset = lineCount(p.header);
        monaco.editor.setModelMarkers(model, MARKER_OWNER, (p.markers ?? []).map(m => {
            const line = Math.min(Math.max(m.line + offset, 1), model.getLineCount());
            return {
                startLineNumber: line,
                endLineNumber: line,
                startColumn: 1,
                endColumn: model.getLineMaxColumn(line),
                message: m.message,
                severity: m.severity === "warning"
                    ? monaco.MarkerSeverity.Warning
                    : monaco.MarkerSeverity.Error,
            };
        }));
    }, [monaco, p.markers, p.header]);

    const height = typeof p.height === "number" ? `${p.height}px` : p.height ?? "14em";

    return (
        <div className="altea-monaco" style={{ height }} ref={container}>
            {monaco == null && <pre className="altea-monaco-loading">{p.header}{p.value}{p.footer}</pre>}
        </div>
    );
}

/**
 * The fixed text around the editable region, each ending (or starting) with the newline that separates it
 * — so the editable region is exactly what lies between, with no boundary newline of its own to lose.
 */
function fences(p: Pick<MonacoProps, "header" | "footer">): { header: string; footer: string } {
    return {
        header: p.header == null || p.header === "" ? "" : p.header + "\n",
        footer: p.footer == null || p.footer === "" ? "" : "\n" + p.footer,
    };
}

function lineCount(text: string | undefined): number {
    return text == null || text === "" ? 0 : text.split("\n").length;
}

/**
 * Where Monaco puts a widget that does not fit inside the editor. ONE for the whole page, appended to the
 * body, so it is clipped by nothing and outranks a Bootstrap modal (an eval is edited inside one).
 */
function overflowWidgets(): HTMLElement {
    let node = document.querySelector<HTMLElement>(".altea-monaco-overflow");
    if (node == null) {
        node = document.createElement("div");
        node.className = "altea-monaco-overflow monaco-editor";
        document.body.appendChild(node);
    }
    return node;
}

let nextModelId = 1;

/** Who OUR markers belong to: the compile errors this component is handed, not the service's own. */
const MARKER_OWNER = "altea";

/**
 * The app's Bootstrap theme, which is what picks Monaco's.
 *
 * Read from <html> FIRST: that is where Bootstrap 5's colour mode lives, and altea sets it there.
 * altea-codemirror's hook of the same name reads only <body>, and so is always light.
 */
function isDarkTheme(): boolean {
    return (document.documentElement.dataset.bsTheme ?? document.body.dataset.bsTheme) === "dark";
}

/** Re-rendered whenever that theme changes. */
export function useBootstrapTheme(): boolean {
    const [isDark, setIsDark] = React.useState(isDarkTheme);

    React.useEffect(() => {
        const observer = new MutationObserver(() => setIsDark(isDarkTheme()));
        // Bootstrap 5 puts the attribute on <html>; a per-section override puts it on an element below.
        // Both are watched, because either is where the app may have set it.
        for (const target of [document.documentElement, document.body])
            observer.observe(target, { attributes: true, attributeFilter: ["data-bs-theme"] });
        return () => observer.disconnect();
    }, []);

    return isDark;
}
