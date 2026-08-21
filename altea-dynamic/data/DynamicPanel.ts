import { init } from "@altea/altea/data/reflection";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";

// Port of Signum.Dynamic's Dynamic.cs (DynamicPanelPermission) plus the one permission the panel actually
// gates on, which Signum keeps in Signum.Eval (`EvalPanelPermission.ViewDynamicPanel`). Signum.Eval is the
// Roslyn host and does not port, so the permission moves here — it is the panel's, not the compiler's.
//
// Signum's `DynamicPanelPermission.RestartApplication` is NOT ported: it guards the button that reloads the
// freshly compiled assembly, and there is no compilation step to restart for.
export namespace DynamicPanelPermission {
    export const ViewDynamicPanel: PermissionSymbol = init();
}
