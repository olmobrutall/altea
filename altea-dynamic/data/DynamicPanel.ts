import { init } from "@altea/altea/data/reflection";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";

// Port of Signum.Dynamic's Dynamic.cs (DynamicPanelPermission) plus the one permission the panel actually
// gates on, which Signum keeps in Signum.Eval (`EvalPanelPermission.ViewDynamicPanel`). Signum.Eval is the
// Roslyn host and does not port, so the permission moves here — it is the panel's, not the compiler's.
//
// `RestartApplication` IS ported, and means what it does in Signum: a DynamicType is compiled and loaded
// while the schema is being BUILT, so a new or changed type takes part only after the process restarts (and
// its table only after a `sync`). The permission gates the button that asks for that restart.
/**
 * What `/api/dynamic/compilationStatus` answers — declared here because a wire DTO is the contract between
 * the route and the page, and neither half should own it (the call @altea/altea-whats-new documents).
 */
export interface DynamicCompilationStatus {
    /** The compile failure, if the server came up WITHOUT its dynamic types. */
    error?: string;
    /** The generated files, relative to the code-gen directory. */
    written: string[];
    /** Where those files are, so a diagnostic naming one can be found. Null when the app did not opt in. */
    codeGenDirectory: string | null;
}

export namespace DynamicPanelPermission {
    export const ViewDynamicPanel: PermissionSymbol = init();
    export const RestartApplication: PermissionSymbol = init();
}
