import type { SchemaBuilder } from "./schema/schemaBuilder";
import { SymbolLogic } from "./symbolLogic";
import { PermissionSymbol } from "../data/permissionSymbol";
import { UnauthorizedAccessException } from "./exceptions";

// Port of Signum/Basics' PermissionLogic.cs — CORE, as Signum has it.
//
// The registry of permissions that are actually IN PLAY, and so the set of rows `basics.permission` holds,
// plus the `isAuthorized` check itself. The check is a SEAM: core owns the vocabulary and the question,
// altea-auth owns the answer and installs it from `PermissionAuthLogic.start`. That is what lets a module
// declare, register AND check a permission without depending on the authorization package at all.
//
// The distinction the registry draws is between DECLARED and REGISTERED. A permission is declared by the
// module that owns it, which happens as soon as anything imports that module's data layer — and a static
// import graph pulls in every module the application could use, not the ones it does. It is REGISTERED by
// that module's `Logic.start`, which runs only for the modules the application actually starts. The symbol
// table is seeded from the REGISTERED set, so an application that never starts the printing module has no
// `PrintPermission.ViewPrintPanel` row — there is nothing to grant, and a row nobody can act on is a row in
// every role-rules screen for no reason.
//
// Note the consequence of getting a registration WRONG in the other direction: a permission whose module
// starts but which nobody registers loses its row — and with it any role rule that pointed at it. The
// synchronizer names such a row in a DELETE, which is the check to run after touching this.
//
// The set is module-level, not per-schema: a process runs one application.

const registered = new Set<PermissionSymbol>();

/** Signum's `Func<PermissionSymbol, string?> IsAuthorizedImplementation`: returns the REFUSAL MESSAGE, or
 *  null when this implementation allows it. Async here, because altea's rule caches are. */
export type IsAuthorizedImplementation = (permission: PermissionSymbol) => Promise<string | null>;

const implementations: IsAuthorizedImplementation[] = [];

let started = false;

export namespace PermissionLogic {

    /** Creates `basics.permission` and seeds it from the REGISTERED set. Idempotent, and called both by
     *  the app (as Southwind's Starter does, before AuthLogic.Start) and by `PermissionAuthLogic.start`,
     *  so an application can have permissions without starting the authorization module at all. */
    export function start(sb: SchemaBuilder): void {
        if (started)
            return;
        started = true;

        SymbolLogic.start(sb, PermissionSymbol, () => registeredPermissions());
    }

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

    /** Signum's `IsAuthorizedImplementation`, which altea-auth installs from `PermissionAuthLogic.start`.
     *  Signum holds ONE multicast Func; a list is the same thing spelled without delegate combination. */
    export function registerIsAuthorizedImplementation(implementation: IsAuthorizedImplementation): void {
        implementations.push(implementation);
    }

    /** The first refusal message any implementation gives, or null when every one of them allows it.
     *
     *  altea divergence: with NO implementation registered this ALLOWS. Signum's field is a non-nullable
     *  `Func` with no initialiser, so `IsAuthorized()` throws a NullReferenceException when
     *  Signum.Authorization was never started. Allowing is both the safer failure and the consistent
     *  answer — an application with no authorization module has no policy to refuse by, which is exactly
     *  what `PermissionAuthLogic.isAuthorized` already concludes for a request with no current role. */
    export async function isAuthorizedString(permission: PermissionSymbol): Promise<string | null> {
        for (const implementation of implementations) {
            const message = await implementation(permission);
            if (message != null)
                return message;
        }
        return null;
    }

    export async function isAuthorized(permission: PermissionSymbol): Promise<boolean> {
        return await isAuthorizedString(permission) == null;
    }

    export async function assertAuthorized(permission: PermissionSymbol): Promise<void> {
        const message = await isAuthorizedString(permission);
        if (message != null)
            throw new UnauthorizedAccessException(message);
    }
}
