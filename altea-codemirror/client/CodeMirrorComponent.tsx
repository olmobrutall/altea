import * as React from "react";
import { Compartment, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { indentSelection, toggleComment } from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
import { classes } from "@altea/altea/data/globals";
import { useUpdatedRef } from "@altea/altea/client/Hooks";
import "./CodeMirror.css";

// Port of Signum.CodeMirror's CodeMirrorComponent.tsx — the one editor host every language wrapper
// (CSharpCodeMirror, HtmlCodeMirror, …) renders.
//
// THE cross-cutting divergence of this module: **CodeMirror 5 → CodeMirror 6**. Signum's package.json
// pins `codemirror` + `@types/codemirror` 5.x, and every file drives the CM5 API (`fromTextArea`,
// `EditorFromTextArea`, an `EditorConfiguration` options BAG, `addLineClass`, side-effect imports of
// `codemirror/addon/**` and `codemirror/mode/**`). CM5 is end-of-life, ships no ESM entry points and no
// bundled types; CM6 is native ESM, carries its own types, and is the only version still receiving
// language support. So the port keeps every wrapper's public props identical (`script` / `onChange` /
// `isReadOnly` / `errorLineNumber` / `innerRef`) and rewrites only what is behind them:
//
//  - the options BAG becomes explicit props plus an `extensions` array — CM6 has no option dictionary,
//    every feature is an Extension. `readOnly` and `extensions` live in Compartments so they can be
//    reconfigured without tearing the editor down (a CM5 `setOption` had no such requirement).
//  - `addLineClass(line, …, "exceptionLine")` becomes the `errorLineField` below: a StateField holding
//    one line Decoration, driven by a StateEffect. A CM6 decoration is state, not a DOM side effect,
//    so it survives (and re-maps through) document changes on its own.
//  - `CodeMirrorComponentHandler.codeMirror` (an `EditorFromTextArea`) becomes `.view` (an `EditorView`).
//    There is no textarea any more: CM6 owns a contenteditable, so the `path` prop (which named the
//    textarea for classic form posts) is gone too.
//  - the CM5 `extraKeys` map is folded into each wrapper's `keymap.of([…])`. F11 fullscreen is not a CM6
//    addon: it is a class on the wrapper div (see `sf-codemirror-fullscreen` in CodeMirror.css).
//  - the dark theme is `@codemirror/theme-one-dark` rather than CM5's `theme/dracula.css`, and it is
//    resolved HERE (from `data-bs-theme`) for every language instead of only in HtmlCodeMirror — that
//    editor's private MutationObserver becomes this shared `useBootstrapTheme()`.

export interface CodeMirrorProps {
    ref?: React.Ref<CodeMirrorComponentHandler>;
    onChange?: (value: string) => void;
    onFocusChange?: (focused: boolean) => void;
    /** Language support and any other CM6 extension. Reconfigured in place when it changes. */
    extensions?: Extension[];
    readOnly?: boolean;
    value?: string | null;
    className?: string;
    errorLineNumber?: number;
    onInit?: (view: EditorView) => void;
}

export interface CodeMirrorComponentHandler {
    view?: EditorView;
}

/**
 * The half of Signum's `extraKeys` map that every wrapper repeated. `basicSetup` already binds CM6's
 * own comment (`Mod-/`), completion (`Ctrl-Space`) and search keys, so only Signum's OWN bindings are
 * re-declared: Ctrl-K / Ctrl-U for comment / uncomment (CM5's `lineComment` / `uncomment` addon).
 * `Ctrl-I` (CM5's `autoFormatRange`) has no CM6 counterpart and maps to indent-selection instead.
 * F11 / Esc live in the component, because fullscreen is its wrapper's class.
 */
export const commonKeymap: Extension = keymap.of([
    { key: "Ctrl-k", run: toggleComment },
    { key: "Ctrl-u", run: toggleComment },
    { key: "Ctrl-i", run: indentSelection },
]);

/** Sets (or clears, with null) the single highlighted error line. 1-based, as Signum's prop is. */
const setErrorLine = StateEffect.define<number | null>();

const errorLineField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(decorations, tr) {
        decorations = decorations.map(tr.changes);

        for (const e of tr.effects) {
            if (e.is(setErrorLine)) {
                if (e.value == null)
                    decorations = Decoration.none;
                else {
                    const lineNumber = Math.min(Math.max(e.value, 1), tr.state.doc.lines);
                    const line = tr.state.doc.line(lineNumber);
                    decorations = Decoration.set([Decoration.line({ class: "sf-cm-exception-line" }).range(line.from)]);
                }
            }
        }

        return decorations;
    },
    provide: f => EditorView.decorations.from(f),
});

/** True while Bootstrap's `data-bs-theme` on <body> says dark. Signum did this inside HtmlCodeMirror only. */
export function useBootstrapTheme(): boolean {
    const [isDark, setIsDark] = React.useState(() => document.body.dataset.bsTheme === "dark");

    React.useEffect(() => {
        const observer = new MutationObserver(() => setIsDark(document.body.dataset.bsTheme === "dark"));
        observer.observe(document.body, { attributes: true, attributeFilter: ["data-bs-theme"] });
        return () => observer.disconnect();
    }, []);

    return isDark;
}

export function CodeMirrorComponent(p: CodeMirrorProps): React.JSX.Element {

    const hostRef = React.useRef<HTMLDivElement>(null);
    const viewRef = React.useRef<EditorView | undefined>(undefined);
    const onChangeRef = useUpdatedRef(p.onChange);
    const onFocusChangeRef = useUpdatedRef(p.onFocusChange);

    const [isFocused, setIsFocused] = React.useState(false);
    const [isFullScreen, setIsFullScreen] = React.useState(false);
    const isDark = useBootstrapTheme();

    // One Compartment pair per editor instance: CM6 reconfigures a compartment's contents without
    // recreating the view (the CM5 `setOption` loop this replaces ran on every render).
    const compartments = React.useMemo(() => ({ readOnly: new Compartment(), extensions: new Compartment() }), []);

    // F11 / Esc — CM5 had a `display/fullscreen` addon; here it is a class on the wrapper.
    const fullScreenKeymap = React.useMemo(() => keymap.of([
        { key: "F11", preventDefault: true, run: () => { setIsFullScreen(f => !f); return true; } },
        { key: "Escape", run: () => { setIsFullScreen(false); return false; } },
    ]), []);

    React.useEffect(() => {
        const view = viewRef.current = new EditorView({
            parent: hostRef.current!,
            state: EditorState.create({
                doc: p.value ?? "",
                extensions: [
                    basicSetup,
                    fullScreenKeymap,
                    errorLineField,
                    EditorView.updateListener.of(u => {
                        if (u.docChanged)
                            onChangeRef.current?.(u.state.doc.toString());
                    }),
                    EditorView.focusChangeEffect.of((_state, focusing) => {
                        setIsFocused(focusing);
                        onFocusChangeRef.current?.(focusing);
                        return null;
                    }),
                    compartments.readOnly.of([EditorState.readOnly.of(p.readOnly ?? false), EditorView.editable.of(!p.readOnly)]),
                    compartments.extensions.of(p.extensions ?? []),
                ],
            }),
        });

        p.onInit?.(view);

        return () => {
            view.destroy();
            viewRef.current = undefined;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Signum's `p.value != codeMirror.getValue()` guard, minus the change-handler detach: a CM6
    // updateListener sees `u.docChanged` for OUR dispatch too, so the guard alone prevents the echo.
    React.useEffect(() => {
        const view = viewRef.current;
        if (view == undefined)
            return;

        const newValue = p.value ?? "";
        const current = view.state.doc.toString();
        if (newValue !== current)
            view.dispatch({ changes: { from: 0, to: current.length, insert: newValue } });
    }, [p.value]);

    React.useEffect(() => {
        viewRef.current?.dispatch({ effects: setErrorLine.of(p.errorLineNumber ?? null) });
    }, [p.errorLineNumber]);

    React.useEffect(() => {
        viewRef.current?.dispatch({
            effects: compartments.readOnly.reconfigure([
                EditorState.readOnly.of(p.readOnly ?? false),
                EditorView.editable.of(!p.readOnly),
            ]),
        });
    }, [p.readOnly]);

    React.useEffect(() => {
        viewRef.current?.dispatch({
            effects: compartments.extensions.reconfigure([...(p.extensions ?? []), ...(isDark ? [oneDark] : [])]),
        });
    }, [p.extensions, isDark]);

    React.useImperativeHandle(p.ref, () => ({ view: viewRef.current }));

    return (
        <div className={classes(
            "sf-codemirror",
            isFocused ? "sf-codemirror-focused" : undefined,
            isFullScreen ? "sf-codemirror-fullscreen" : undefined,
            p.className)}
            ref={hostRef} />
    );
}
