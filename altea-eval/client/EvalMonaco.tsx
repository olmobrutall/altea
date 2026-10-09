import * as React from "react";
import TypeScriptMonaco from "@altea/altea-monaco/client/TypeScriptMonaco";
import type { FencePart, MonacoEditor, MonacoMarker } from "@altea/altea-monaco/client/MonacoComponent";
import type { Monaco } from "@altea/altea-monaco/client/monaco";
import { EvalMessage } from "../data/Eval";
import { useEvalIntelliSense, type EvalIntelliSense } from "./EvalIntelliSense";

// A TypeScript editor over a FRAGMENT of generated code: the configured imports, then `header` (the
// declarations and the opening line the fragment lives in), the fragment, then `footer`. The imports are
// always HIDDEN, and the caller hides whatever else is scaffolding, so what stays visible reads like the
// generated code; a link reveals the rest. Names used without importing are resolved the way EvalCompiler
// resolves them, and their imports are written into the hidden block.
//
// THE IMPORTS ARE WRITTEN HERE, and they are the same ones the server writes. The eager half comes with
// the configuration; the lazy half is discovered by asking Monaco which names it could not resolve and
// looking each up — the identical pass EvalCompiler runs (see EvalIntelliSense). If the two ever
// disagree, the editor is wrong and the save is right, which is the safe way round.
//
// ONE KNOWN GAP: an import the author writes at the top of the fragment. The server HOISTS it above the
// signature and it wins over the implicit one; the editor leaves it in the body, where Monaco calls it a
// misplaced import declaration. Closing it needs an editable region ABOVE the header as well as below it,
// which the one-header/one-footer model cannot express.

export interface EvalMonacoProps {
    code: string;
    onChange?: (code: string) => void;
    /** What sits between the imports and the fragment — e.g. a visible `function evaluate(e: X): boolean {`. */
    header: readonly FencePart[];
    footer: readonly FencePart[];
    /** When this changes the editor is showing a DIFFERENT script, so the imports it discovered are dropped. */
    subject?: unknown;
    isReadOnly?: boolean;
    height?: number | string;
    markers?: readonly MonacoMarker[];
    fenceHint?: string;
    /** Which import configuration to resolve names against (EvalLogic.registerImportsProfile); none is the base. */
    profile?: string;
    /** The model's path, when another editor imports this one by it; otherwise one is made up per editor. */
    path?: string;
    /**
     * Names provided by OTHER live models rather than by the configuration — identifier -> relative
     * specifier (`PizzaEntity` -> `./__dynamic_1__`). Monaco's worker sees every open model, so nothing has
     * to be loaded for them.
     */
    extraNames?: ReadonlyMap<string, string>;
    /** Run once the editor exists, for anything this component does not wrap (following the cursor). */
    onMount?: (editor: MonacoEditor, monaco: Monaco) => void;
}

export function EvalMonaco(p: EvalMonacoProps): React.JSX.Element {
    const intelliSense = useEvalIntelliSense(p.profile);

    // A path under the root the declarations were laid out for, so a relative specifier (`./app/orders/…`,
    // which is how an app's own modules are named) resolves — and distinct per editor, so two editors on
    // one page do not share a program.
    const ownPath = React.useMemo(() => `file:///eval/__altea_eval_${nextEditorId++}__.ts`, []);
    const path = p.path ?? ownPath;

    const extraKey = JSON.stringify([...p.extraNames ?? []]);
    const specifierFor = React.useCallback((name: string): string | undefined =>
        p.extraNames?.get(name) ?? intelliSense?.specifierFor(name),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [intelliSense, extraKey]);

    // Only ever grows while the editor shows ONE script: a name that resolved once stays resolvable, and
    // re-checking after every keystroke would make the editor flicker between knowing and not knowing
    // what `OrderEntity` is.
    const [implicit, setImplicit] = React.useState<readonly string[]>([]);

    // ...but React reuses a component instance across a navigation that lands on the same shape of page,
    // so without this the names the LAST script needed are still written into this one's header.
    React.useEffect(() => setImplicit([]), [p.subject]);

    const headerKey = JSON.stringify(p.header);
    const header = React.useMemo(
        () => buildHeader(intelliSense, specifierFor, implicit, p.header),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [intelliSense, specifierFor, implicit, headerKey]);

    // Debounced because it costs a round trip to the worker, and a declaration fetch when it finds something.
    React.useEffect(() => {
        if (intelliSense == null)
            return;

        let cancelled = false;
        const handle = setTimeout(() => void (async () => {
            const unresolved = await intelliSense.unresolvedNames(path);
            const found = unresolved.filter(n => specifierFor(n) != null && !implicit.includes(n));
            if (found.length === 0 || cancelled)
                return;

            await intelliSense.load(found.filter(n => p.extraNames?.has(n) !== true).map(n => specifierFor(n)!));
            if (!cancelled)
                setImplicit(previous => [...new Set([...previous, ...found])]);
        })(), 400);

        return () => { cancelled = true; clearTimeout(handle); };
    }, [intelliSense, specifierFor, path, p.code, header, implicit]);

    return (
        <TypeScriptMonaco code={p.code}
            header={header}
            footer={p.footer}
            path={path}
            isReadOnly={p.isReadOnly}
            height={p.height}
            markers={p.markers}
            fenceHint={p.fenceHint}
            hiddenToggle={{
                show: EvalMessage.ShowGeneratedCode.niceToString(),
                hide: EvalMessage.HideGeneratedCode.niceToString(),
            }}
            onMount={p.onMount}
            onChange={p.onChange} />
    );
}

/** What every script gets, then what this one turned out to need — hidden — then the caller's header. */
function buildHeader(intelliSense: EvalIntelliSense | null, specifierFor: (name: string) => string | undefined,
    implicit: readonly string[], rest: readonly FencePart[]): readonly FencePart[] {

    if (intelliSense == null)
        return rest;                // before the configuration lands, the caller's header alone

    const grouped = new Map<string, string[]>();
    for (const name of implicit) {
        const specifier = specifierFor(name);
        if (specifier == null)
            continue;
        let group = grouped.get(specifier);
        if (group == null)
            grouped.set(specifier, group = []);
        group.push(name);
    }

    const imports = [
        ...intelliSense.eagerLines,
        ...[...grouped].map(([specifier, names]) =>
            `import { ${names.sort().join(", ")} } from "${specifier}";`),
    ].join("\n");

    return [{ text: imports, hidden: true }, ...rest];
}

let nextEditorId = 1;
