import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";

// Loading Monaco, ONCE and LAZILY.
//
// Lazily because Monaco is several megabytes and almost no page needs it: only a stored SCRIPT is edited
// with one. A static import would put all of it in the entry chunk of an application that may never open
// an eval. So the editor component awaits this, and the bundler gets a chunk boundary it can honour.
//
// Once because `MonacoEnvironment` is GLOBAL and is read the first time a model wants a worker. Setting it
// twice is harmless; setting it LATE is not — Monaco falls back to loading workers over the network and
// fails under any reasonable CSP. So it is set here, before this module ever hands Monaco out, and the
// promise is memoised so a second editor on the same page reuses the first load.
//
// NEW in altea, with no Signum counterpart: Signum's editors are CodeMirror throughout.

export type Monaco = typeof import("monaco-editor");

let loading: Promise<Monaco> | undefined;

export function loadMonaco(): Promise<Monaco> {
    return loading ??= load();
}

async function load(): Promise<Monaco> {
    // Set BEFORE Monaco is imported: the first model created starts a worker, and by then this has to
    // answer. `label` is the language the worker is for; everything that is not a dedicated language
    // service uses the plain editor worker.
    self.MonacoEnvironment = {
        getWorker: (_workerId: string, label: string) => {
            switch (label) {
                case "typescript": case "javascript": return new tsWorker();
                case "css": case "scss": case "less": return new cssWorker();
                case "html": case "handlebars": case "razor": return new htmlWorker();
                default: return new editorWorker();
            }
        },
    };

    const monaco = await import("monaco-editor");

    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
        // Monaco bundles its OWN TypeScript, whose enum stops short of the one altea builds with;
        // ESNext is the nearest honest answer and is what every lib the script sees was emitted for.
        target: monaco.languages.typescript.ScriptTarget.ESNext,
        module: monaco.languages.typescript.ModuleKind.ESNext,
        moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        strict: true,
        strictPropertyInitialization: false,
        experimentalDecorators: true,
        esModuleInterop: true,
        skipLibCheck: true,
        allowNonTsExtensions: true,
        noEmit: true,
    });

    // SEMANTIC validation is OFF until someone supplies declarations. A stored script names an entity,
    // a query and an operation, none of which Monaco has ever heard of — so leaving it on would underline
    // every meaningful line in the editor and teach the author to ignore the squiggles that matter.
    // Whoever loads the declarations turns it on (see setSemanticValidation).
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: true,
        noSyntaxValidation: false,
        noSuggestionDiagnostics: true,
    });

    return monaco;
}

