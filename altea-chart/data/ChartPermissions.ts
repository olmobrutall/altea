import { init } from "@altea/altea/data/reflection";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";

// Port of Signum's ChartPermission (Signum.Chart/ChartPermissions.cs). Reuses altea-auth's single
// PermissionSymbol table (like UserQueryPermission).
export namespace ChartPermission {
    export const ViewCharting: PermissionSymbol = init();
}
