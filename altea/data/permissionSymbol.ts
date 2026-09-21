import { init } from './reflection';
import { entity } from './decorators';
import { Symbol } from './symbol';

// Port of Signum's PermissionSymbol (Signum/Basics/PermissionSymbol.cs) — CORE, as Signum has it, not
// the authorization module.
//
// A permission is core VOCABULARY: every module declares its own, and only the RULES that grant one
// belong to authorization. Keeping the symbol here is what lets a module declare and check a permission
// without depending on the auth package at all — the same reason `IUserEntity` and `UserHolder` sit in
// ./security rather than in altea-auth. The check itself goes through PermissionLogic's
// `isAuthorizedImplementation` seam, which altea-auth fills at start.
//
// `@entity(...)` alone carries the kind/data AND the registration, as OperationSymbol and TypeEntity,
// the other SystemString system tables, declare it.
//
// The table is `basics.permission`, which is the schema this folder already declares by default — so
// unlike OperationSymbol (which Signum puts in an `operations` schema) there is no setDatabaseSchema
// override here, and moving the class out of altea-auth does NOT move the table.
@entity("SystemString", "Master")
export class PermissionSymbol extends Symbol {
}

// The framework's own permissions; modules and apps declare their own the same way.
export namespace BasicPermission {
    export const AdminRules: PermissionSymbol = init();
    export const AutomaticUpgradeOfProperties: PermissionSymbol = init();
    export const AutomaticUpgradeOfQueries: PermissionSymbol = init();
    export const AutomaticUpgradeOfOperations: PermissionSymbol = init();
}
