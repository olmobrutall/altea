import { init } from "@altea/altea/data/reflection";
import type { PermissionSymbol } from "@altea/altea-auth/data/Rules";

// Signum.Eval's `EvalPanelPermission` (declared in EvalEmbedded.cs). Its own module because a permission
// container is a symbol container: the metadata builder groups it by the container half of the key, so
// keeping it apart from the entity model makes the one thing this file declares obvious.
//
// altea note: @altea/altea-dynamic already declares its own `DynamicPanelPermission.ViewDynamicPanel`, which
// gates the dynamic-VIEW admin pages it owns. This one gates the EVAL surface — the eval-errors endpoint and
// whatever UI walks it — which is the split Signum has too (Signum.Dynamic's panel page reads
// EvalPanelPermission, but the permission itself belongs to Signum.Eval).
export namespace EvalPanelPermission {
    export const ViewDynamicPanel: PermissionSymbol = init();
}
