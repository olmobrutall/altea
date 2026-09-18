import { init } from "@altea/altea/data/reflection";
import type { PermissionSymbol } from "@altea/altea/data/permissionSymbol";

// Its own module because a permission container is a symbol container: the metadata builder groups it by
// the container half of the key, so keeping it apart from the entity model makes the one thing this file
// declares obvious.
//
// This is the ONE ViewDynamicPanel: @altea/altea-dynamic's panel page reads it from HERE rather than
// declaring a second under its own container — two containers would be two permissions, and a role granted
// one would not have the other. `DynamicPanelPermission` keeps only `RestartApplication`.
export namespace EvalPanelPermission {
    export const ViewDynamicPanel: PermissionSymbol = init();
}
