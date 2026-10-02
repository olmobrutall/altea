import * as React from "react";
import { ajaxPost } from "@altea/altea/client/Services";
import { loadMonaco, type Monaco } from "@altea/altea-monaco/client/monaco";

// The editor's half of the module configuration.
//
// The server resolves a name a script writes against the lazy half of `EvalImports` and writes the import
// for it (see EvalCompiler's implicit-import pass). The EDITOR has to do exactly the same thing, for the
// same reason the server does: a script that says `OrderEntity` without importing it is correct, and an
// editor that does not know that underlines it in red. So this runs the same pass, over the same map,
// fetched from the server.
//
// What it is NOT is a second compiler. Monaco's TypeScript service does the checking; this only decides
// WHICH DECLARATIONS it is given, and writes the import lines the author did not have to.
//
// Eager up front, lazy on demand. The eager closure is about half a megabyte (the framework's own `.d.ts`
// graph, minus `@types/*`, which a script cannot reach anyway); the lazy half is far larger and almost
// none of it is ever needed, so a module's declarations are fetched the first time a script names
// something in it — about 60 KB for an entity domain.

const intelliSenseRoute = "/api/eval/intelliSense";
const declarationsRoute = "/api/eval/declarations";

interface DeclarationFile { path: string; content: string }

interface IntelliSenseResponse {
    eagerLines: string[];
    names: [string, string][];
    root: string;
    declarations: DeclarationFile[];
}

export interface EvalIntelliSense {
    /** The import lines every script gets, shown above the author's own text. */
    readonly eagerLines: readonly string[];
    /** The module that provides a name, or undefined when nothing does. */
    specifierFor(name: string): string | undefined;
    /**
     * Load the declarations for these modules, if they are not loaded already. Resolves once the editor
     * can check against them.
     */
    load(specifiers: readonly string[]): Promise<void>;
    /** The names the editor cannot resolve in the model at `uri`, asked of Monaco's own checker. */
    unresolvedNames(uri: string): Promise<string[]>;
}

let loading: Promise<EvalIntelliSense> | undefined;

/** Loaded ONCE per page: the map is the same for every editor, and so are the declarations. */
export function loadIntelliSense(): Promise<EvalIntelliSense> {
    return loading ??= build();
}

async function build(): Promise<EvalIntelliSense> {
    const [monaco, response] = await Promise.all([
        loadMonaco(),
        ajaxPost<IntelliSenseResponse>({ url: intelliSenseRoute }, {}),
    ]);

    const names = new Map(response.names);
    const loaded = new Set<string>();           // declaration PATHS the editor already holds
    const requested = new Set<string>();        // module specifiers already asked for

    function register(declarations: readonly DeclarationFile[]): void {
        for (const file of declarations) {
            if (loaded.has(file.path))
                continue;
            loaded.add(file.path);
            monaco.languages.typescript.typescriptDefaults.addExtraLib(file.content, file.path);
        }
    }

    register(response.declarations);
    for (const line of response.eagerLines) {
        const specifier = /from\s+"([^"]+)"/.exec(line)?.[1];
        if (specifier != null)
            requested.add(specifier);
    }

    // Only now: before the declarations are in, every meaningful line of every script is an error, and an
    // editor that cries wolf is worse than one that says nothing (see monaco.ts).
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
        noSuggestionDiagnostics: true,
    });

    return {
        eagerLines: response.eagerLines,

        specifierFor: name => names.get(name),

        async load(specifiers) {
            const wanted = specifiers.filter(s => !requested.has(s));
            if (wanted.length === 0)
                return;

            for (const s of wanted)
                requested.add(s);

            register(await ajaxPost<DeclarationFile[]>({ url: declarationsRoute },
                { specifiers: wanted, have: [...loaded] }));
        },

        unresolvedNames: uri => unresolvedNames(monaco, uri),
    };
}

/**
 * The names Monaco could not resolve — asked of its own TypeScript worker rather than worked out here.
 *
 * Exactly what the server does, and for the same reason: "cannot find name" IS the question, TypeScript
 * answers it precisely (in type position, inside a generic argument, everywhere a hand-written scan would
 * be wrong), and the two halves agreeing is the whole point.
 */
async function unresolvedNames(monaco: Monaco, uri: string): Promise<string[]> {
    // The text is read from the MODEL, not rebuilt from the parts: a diagnostic is an offset into what the
    // worker actually checked, and reconstructing that text here would mean reproducing the exact newlines
    // the editor composed — a detail no caller should have to get right.
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (model == null)
        return [];                                  // the editor has not mounted yet

    const text = model.getValue();
    const worker = await monaco.languages.typescript.getTypeScriptWorker();
    const client = await worker(model.uri);
    const diagnostics = await client.getSemanticDiagnostics(uri);

    const found = new Set<string>();
    for (const d of diagnostics)
        // 2304 "Cannot find name 'X'", 2552 the same with a suggestion attached. The span IS the
        // identifier, so the name is read off the source rather than scraped out of the message.
        if ((d.code === 2304 || d.code === 2552) && d.start != null && d.length != null)
            found.add(text.substr(d.start, d.length));

    return [...found];
}

/**
 * The configuration, for a component that needs it. Null until it has loaded — the editor renders without
 * IntelliSense in the meantime rather than waiting, since half a megabyte of declarations is no reason to
 * stare at an empty box.
 */
export function useEvalIntelliSense(): EvalIntelliSense | null {
    const [value, setValue] = React.useState<EvalIntelliSense | null>(null);

    React.useEffect(() => {
        let alive = true;
        void loadIntelliSense().then(is => { if (alive) setValue(is); });
        return () => { alive = false; };
    }, []);

    return value;
}
