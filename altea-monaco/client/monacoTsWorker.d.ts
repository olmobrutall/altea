// Monaco ships its TypeScript worker as an ES module with no typings; these are the parts
// altea.worker.ts extends.
declare module "monaco-editor/esm/vs/language/typescript/ts.worker" {
    import type * as typescript from "typescript";

    export class TypeScriptWorker {
        constructor(ctx: unknown, createData: unknown);
        protected _languageService: typescript.LanguageService;
    }

    export function initialize(factory: (ctx: unknown, createData: unknown) => unknown): void;

    /** A narrow facade; the whole compiler API is its `typescript` member. */
    export const ts: { typescript: typeof typescript };
}
