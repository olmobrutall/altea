import { PermissionSymbol } from "../data/Rules";

// Port of Signum/Basics' PermissionLogic.cs — see docs/port/Auth.md.
//
// The registry of permissions that
// are actually IN PLAY, and so the set of rows `basics.permission` holds.
//
// The distinction it draws is between DECLARED and REGISTERED. A permission is declared by the module that
// owns it, which happens as soon as anything imports that module's data layer — and a static import graph
// pulls in every module the application could use, not the ones it does. It is REGISTERED by that module's
// `Logic.start`, which runs only for the modules the application actually starts. The symbol table is
// seeded from the REGISTERED set, so an application that never starts the printing module has no
// `PrintPermission.ViewPrintPanel` row — there is nothing to grant, and a row nobody can act on is a row
// in every role-rules screen for no reason.
//
// Note the consequence of getting a registration WRONG in the other direction: a permission whose
// module starts but which nobody registers loses its row — and with it any role rule that pointed at it.
// The synchronizer names such a row in a DELETE, which is the check to run after touching this.
//
// The set is module-level, not per-schema: a process runs one application.

const registered = new Set<PermissionSymbol>();

export namespace PermissionLogic {
    /** Call from the owning module's
     *  `Logic.start`; idempotent, and order-free (the symbol table reads the set lazily, at
     *  generation / synchronization time). */
    export function registerPermissions(...permissions: PermissionSymbol[]): void {
        for (const p of permissions) {
            if (p == null)
                throw new Error("PermissionLogic.registerPermissions: a permission is null — was it declared with init()?");
            registered.add(p);
        }
    }

    /**
     * Register every permission a CONTAINER declares, for a
     * module that owns a whole family of them. Pass the namespace object itself
     * (`registerContainer(CachePermission)`); a TypeScript namespace IS an object at runtime, so its
     * PermissionSymbol members enumerate the way a container's public static fields do.
     */
    export function registerContainer(container: object): void {
        const found = Object.values(container).filter((v): v is PermissionSymbol => v instanceof PermissionSymbol);
        if (found.length === 0)
            throw new Error("PermissionLogic.registerContainer: the container declares no PermissionSymbol.");
        registerPermissions(...found);
    }

    /** Read lazily by the symbol table's seed / sync. */
    export function registeredPermissions(): PermissionSymbol[] {
        return [...registered];
    }
}
