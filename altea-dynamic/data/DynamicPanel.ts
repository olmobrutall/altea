import { init } from "@altea/altea/data/reflection";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";

// Port of Signum.Dynamic's Dynamic.cs (DynamicPanelPermission) plus the one permission the panel actually
// gates on, which Signum keeps in Signum.Eval (`EvalPanelPermission.ViewDynamicPanel`). Signum.Eval is the
// Roslyn host and does not port, so the permission moves here — it is the panel's, not the compiler's.
//
// `RestartApplication` IS ported, and means what it does in Signum: a DynamicType is compiled and loaded
// while the schema is being BUILT, so a new or changed type takes part only after the process restarts (and
// its table only after a `sync`). The permission gates the button that asks for that restart.
export namespace DynamicPanelPermission {
    export const ViewDynamicPanel: PermissionSymbol = init();
    export const RestartApplication: PermissionSymbol = init();
}
