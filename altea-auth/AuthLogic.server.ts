import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/operationFluentInclude"; // FluentInclude.withSave/.withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import { AsyncLocalStorage } from "node:async_hooks";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { graph } from "@altea/altea/server/graphBuilder";
import { table } from "@altea/altea/server/table";
import { DirectedGraph } from "@altea/altea/server/directedGraph";
import { UserHolder } from "@altea/altea/server/userHolder";
import { Temporal } from "@altea/altea/data/basics";
import { Lite } from "@altea/altea/data/lite";
import { UserWithClaims } from "@altea/altea/data/security";
import { PasswordEncoding } from "@altea/altea/server/passwordEncoding";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { UserEntity, UserState, UserOperation } from "./User.data";
import { RoleEntity, RoleOperation, MergeStrategy } from "./Role.data";
import { UserMessage, LoginAuthMessage } from "./AuthMessages.data";
// NOTE: AuthServer imports back from AuthLogic — a runtime-only cycle (both sides use the other only
// inside functions, never at module-eval), so ESM resolves it fine. AuthServer is invoked lazily from
// start() below, guarded by sb.webBuilder.
import { AuthServer } from "./AuthServer.server";

// Port of Signum's AuthLogic (Signum.Authorization/AuthLogic.cs) — the AUTHENTICATION half. The
// authorization half (role graph / merge strategies / rule caches) lands in Phase 4; the extension
// seams Signum exposes there (`Authorizer`, `UserLogingIn`, `Disable`) are declared here now so the
// controller and future modules wire against a stable surface.
//
// altea divergences, documented inline:
//  - `Database.Query<UserEntity>().Where(...)` → altea's `table(UserEntity).filter(...)` (a @quoted
//    predicate; closures over locals are captured by the transformer, e.g. bulkInserter).
//  - `IDisposable Disable()` (suppresses authorization) → `withDisabled(fn)` callback scope. It is a
//    NO-OP until the authorization engine exists (Phase 4 makes it actually suppress rule checks).
//  - Counter/hash writes use `user.save()` directly (altea has no RequiresSaveOperation guard yet), not
//    Signum's `AllowSave` + `Execute(Save)`.
//  - `CultureInfo` claim/`OnLogin_UpdateUserCulture` omitted (no CultureInfoEntity ported).

/** Signum's ICustomAuthorizer (ICustomAuthorizer.cs) — the pluggable login seam (AD / OpenID). */
export interface ICustomAuthorizer {
    login(username: string, password: string): Promise<{ user: UserEntity; authenticationType: string }>;
}

// The specific login exceptions (Signum's UserEntity.cs) — the controller maps each to a field error.
export class IncorrectUsernameException extends Error { constructor(message?: string) { super(message); this.name = "IncorrectUsernameException"; } }
export class IncorrectPasswordException extends Error { constructor(message?: string) { super(message); this.name = "IncorrectPasswordException"; } }
export class UserLockedException extends Error { constructor(message?: string) { super(message); this.name = "UserLockedException"; } }

export namespace AuthLogic {
    // Signum's `event Action<UserEntity, string> UserLogingIn` — modules hook post-login side effects.
    export const userLogingIn: ((user: UserEntity, loginMethod: string) => void)[] = [];

    // Signum's `ICustomAuthorizer? Authorizer` — when set, the controller delegates login to it.
    export let authorizer: ICustomAuthorizer | null = null;

    // Signum's `int? MaxFailedLoginAttempts` — lock the user after this many consecutive failures.
    export let maxFailedLoginAttempts: number | null = null;

    // Signum's SystemUserName / AnonymousUserName. Not persisted config yet — set by the host if wanted.
    export let systemUserName: string | null = null;
    export let anonymousUserName: string | null = null;

    export async function systemUser(): Promise<UserEntity | null> {
        return systemUserName == null ? null : await retrieveUserByUsername(systemUserName);
    }
    export async function anonymousUser(): Promise<UserEntity | null> {
        return anonymousUserName == null ? null : await retrieveUserByUsername(anonymousUserName);
    }

    // Signum's `AuthLogic.Disable()` / `AuthLogic.IsEnabled`. `withDisabled` runs `fn` with authorization
    // SUPPRESSED for its (async-propagated) scope — the row-read filter, the save gate, and isAllowedFor
    // all short-circuit to "allowed" while disabled. Used by trusted internal flows (e.g. changePassword,
    // the login failed-counter writes) that must bypass the current role's rules. Backed by an
    // AsyncLocalStorage so it holds across the awaited work inside `fn` (like UserHolder).
    const disabledStorage = new AsyncLocalStorage<boolean>();
    export function withDisabled<R>(fn: () => R): R {
        return disabledStorage.run(true, fn);
    }
    export function isEnabled(): boolean {
        return disabledStorage.getStore() !== true;
    }

    export function start(sb: SchemaBuilder): void {
        // Signum's FillClaims += … : stamp Role / ExternalId onto the claims bag when a UserWithClaims is
        // built from a full user (Culture omitted — no CultureInfoEntity). Read server-side by the token
        // and by RoleEntity.current().
        UserWithClaims.fillClaims.push((uwc, user) => {
            const u = user as UserEntity;
            uwc.claims["Role"] = u.role;
            uwc.claims["ExternalId"] = u.externalId;
        });

        sb.include(RoleEntity).withQuery()
            .withSave(RoleOperation.Save)
            .withDelete(RoleOperation.Delete);

        sb.include(UserEntity).withQuery();
        UserGraph.register();

        // Drop the cached role graph when a role changes (Signum's InvalidateWith(RoleEntity)). Fired
        // after the save commits; the authorization caches register their own invalidations too.
        sb.schema.entityEvents(RoleEntity).saved.push(() => AuthLogic.invalidateRoles());

        // Signum's `if (sb.WebServerBuilder != null) AuthServer.Start(...)`: when the host set a web
        // builder on the SchemaBuilder, wire the whole auth HTTP surface (authentication middleware +
        // /api/auth, the role-filtered reflection blob, and the /api/authAdmin rule-pack routes). A
        // terminal / test build leaves webBuilder undefined, so no HTTP is mounted.
        if (sb.webBuilder)
            AuthServer.start(sb.webBuilder);
    }

    // Signum's RetrieveUserByUsername (a swappable Func). Exact-match on userName (Signum lowercases both
    // sides; usernames are treated as exact here — documented divergence).
    export let retrieveUserByUsername: (username: string) => Promise<UserEntity | null> =
        (username) => table(UserEntity).filter(u => u.userName == username).singleOrNull() as Promise<UserEntity | null>;

    // Signum's RetrieveUser(username): resolve, and reject a deactivated user outright.
    export async function retrieveUser(username: string): Promise<UserEntity | null> {
        const user = await retrieveUserByUsername(username);
        if (user != null && user.state === UserState.Deactivated)
            throw new UserLockedException(LoginAuthMessage.User0IsDeactivated.niceToString(user.userName));
        return user;
    }

    // Signum's CheckUserActive.
    export function checkUserActive(user: UserEntity): void {
        if (user.state !== UserState.Active)
            throw new UnauthorizedAccessException(UserMessage.UserIsNotActive.niceToString());
    }

    // Signum's AuthLogic.Login(username, password): hash + delegate to the hash-comparing retrieve.
    export async function login(username: string, password: string): Promise<{ user: UserEntity; authenticationType: string }> {
        const passwordHash = PasswordEncoding.hashPassword(username, password);
        const alternatives = PasswordEncoding.hashPasswordAlternatives(username, password);
        const user = await retrieveUserAndCheckPassword(username, passwordHash, alternatives);
        onUserLogingIn(user, "Login");
        return { user, authenticationType: "database" };
    }

    export function onUserLogingIn(user: UserEntity, loginMethod: string): void {
        for (const fn of userLogingIn)
            fn(user, loginMethod);
    }

    // Signum's RetrieveUser(username, passwordHash, alternatives): the password-checking core, including
    // the failed-counter / lockout handling and the on-success hash upgrade.
    async function retrieveUserAndCheckPassword(username: string, passwordHash: Buffer, alternatives: Buffer[]): Promise<UserEntity> {
        const user = await retrieveUser(username);
        if (user == null)
            throw new IncorrectUsernameException(LoginAuthMessage.Username0IsNotValid.niceToString(username));

        const stored = decodeHash(user.passwordHash);
        const candidates = [passwordHash, ...alternatives];
        const matches = stored != null && candidates.some(c => PasswordEncoding.sequenceEqual(c, stored));

        if (!matches) {
            user.loginFailedCounter++;
            await user.save();

            if (maxFailedLoginAttempts != null && user.loginFailedCounter >= maxFailedLoginAttempts && user.state === UserState.Active) {
                user.disabledOn = Temporal.Now.plainDateTimeISO();
                user.state = UserState.Deactivated;
                await user.save();
                throw new UserLockedException(LoginAuthMessage.User0IsDeactivated.niceToString(user.userName));
            }
            throw new IncorrectPasswordException(LoginAuthMessage.IncorrectPassword.niceToString());
        }

        if (user.loginFailedCounter > 0) {
            user.loginFailedCounter = 0;
            await user.save();
        }

        // Upgrade a legacy (alternative) hash to the primary scheme on successful login (store the raw
        // primary-hash bytes if the stored bytes differ).
        if (user.passwordHash == null || !PasswordEncoding.sequenceEqual(Buffer.from(user.passwordHash), passwordHash)) {
            user.passwordHash = passwordHash;
            await user.save();
        }

        return user;
    }
}

// --- passwordHash helpers (see User.data.ts divergence note) ---
// encodeHash: a stable base64 STRING fingerprint of the hash — for the auth token's password-change
// detector (AuthTokenServer.ph). NOT for storage; the column stores the raw bytes (a Uint8Array).
export function encodeHash(hash: Buffer): string {
    return hash.toString("base64");
}
// decodeHash: the stored binary hash (a Uint8Array read from the DB) as a Buffer, for comparison.
export function decodeHash(stored: Uint8Array | null): Buffer | null {
    return stored == null ? null : Buffer.from(stored);
}

// Port of Signum's UserGraph (Signum.Authorization/UserGraph.cs): the user activation state machine.
// (Deactivate/AutoDeactivate side effects that touch the authorization cache / UserTicket land later.)
export const UserGraph = graph(UserEntity, UserState, g => {
    g.GetState = u => u.state;

    g.Construct(UserOperation.Create, {
        toStates: [UserState.New],
        construct: () => UserEntity.create({ state: UserState.New }),
    });

    g.Execute(UserOperation.Save, {
        fromStates: [UserState.Active, UserState.New],
        toStates: [UserState.Active],
        canBeNew: true,
        canBeModified: true,
        execute: async u => {
            u.state = UserState.Active;
            // passwordHash is @serialize(false), so a client-originated save carries none. altea UPDATEs
            // every column, so re-load the stored hash for an existing user to avoid nulling it out
            // (Signum keeps it via the DB-merge model binder). New users get their hash set elsewhere
            // (seed / the future DoublePassword → newPassword flow).
            if (!u.isNew && u.passwordHash == null) {
                const stored = await table(UserEntity).filter(x => x.id == u.id).singleOrNull() as UserEntity | null;
                if (stored != null)
                    u.passwordHash = stored.passwordHash;
            }
        },
    });

    g.Execute(UserOperation.Deactivate, {
        fromStates: [UserState.Active],
        toStates: [UserState.Deactivated],
        execute: u => {
            u.disabledOn = Temporal.Now.plainDateTimeISO();
            u.state = UserState.Deactivated;
        },
    });

    g.Execute(UserOperation.AutoDeactivate, {
        fromStates: [UserState.Active],
        toStates: [UserState.AutoDeactivate],
        execute: u => {
            u.disabledOn = Temporal.Now.plainDateTimeISO();
            u.state = UserState.AutoDeactivate;
        },
    });

    g.Execute(UserOperation.Reactivate, {
        fromStates: [UserState.Deactivated, UserState.AutoDeactivate],
        toStates: [UserState.Active],
        execute: u => {
            u.disabledOn = null;
            u.state = UserState.Active;
        },
    });

    g.Delete(UserOperation.Delete, {
        fromStates: [UserState.Deactivated, UserState.AutoDeactivate, UserState.Active],
        delete: u => u.delete(),
    });
});

// ---- Role graph (Signum's AuthLogic role infrastructure) ----------------------------------------
//
// The inherit/merge DAG that every authorization cache folds rules over. Signum keeps this in
// GlobalLazy ResetLazys; altea has no GlobalLazy, so it is a single async-loaded, reset-able snapshot
// (invalidateRoles() drops it — call when roles change). Roles are keyed by their Lite key string
// ("Role;<id>") so the DirectedGraph uses value identity (a Lite instance is not reference-stable).

interface RoleGraphData {
    rolesByKey: Map<string, RoleEntity>;
    graph: DirectedGraph<string>;
    // Per role: its merge strategy + the DEFAULT-allowed flag (Union → any base allowed; Intersection →
    // all base allowed; a root role → false for Union, true for Intersection). Signum's RoleData.
    mergeStrategies: Map<string, { strategy: MergeStrategy; defaultAllowed: boolean }>;
    order: string[]; // compilation order (parents before children)
}

let _roleGraph: RoleGraphData | undefined;

async function loadRoleGraph(): Promise<RoleGraphData> {
    const roles = await table(RoleEntity).toArray() as RoleEntity[];
    const rolesByKey = new Map<string, RoleEntity>(roles.map(r => [r.toLite().key(), r]));

    const graph = DirectedGraph.generate<string>(
        rolesByKey.keys(),
        key => rolesByKey.get(key)!.inheritsFrom.map(row => row.inheritsFrom.key()),
    );

    const feedback = graph.feedbackEdgeSet();
    if (!feedback.isEmpty)
        throw new Error("Cycles found in the role graph: " + feedback.edges.map(e => `${e.from} -> ${e.to}`).join(", "));

    const order = graph.compilationOrder();
    const mergeStrategies = new Map<string, { strategy: MergeStrategy; defaultAllowed: boolean }>();
    for (const key of order) {
        const role = rolesByKey.get(key)!;
        const baseDefaults = [...graph.tryRelatedTo(key)].map(p => mergeStrategies.get(p)!.defaultAllowed);
        const strategy = role.mergeStrategy;
        const defaultAllowed = strategy === MergeStrategy.Union ? baseDefaults.some(x => x) : baseDefaults.every(x => x);
        mergeStrategies.set(key, { strategy, defaultAllowed });
    }

    return { rolesByKey, graph, mergeStrategies, order };
}

export namespace AuthLogic {
    /** The loaded role-graph snapshot (Signum's RolesByLite/rolesGraph/mergeStrategies GlobalLazys). */
    export async function roleGraph(): Promise<RoleGraphData> {
        if (_roleGraph == null)
            _roleGraph = await loadRoleGraph();
        return _roleGraph;
    }

    /** Drop the cached role graph (Signum's InvalidateWith(RoleEntity)); call after roles change. */
    export function invalidateRoles(): void {
        _roleGraph = undefined;
    }

    /** Direct inherited roles of `roleKey` (Signum's AuthLogic.RelatedTo). Keys, not entities. */
    export async function relatedTo(roleKey: string): Promise<Set<string>> {
        return (await roleGraph()).graph.tryRelatedTo(roleKey);
    }

    export async function getMergeStrategy(roleKey: string): Promise<MergeStrategy> {
        return (await roleGraph()).mergeStrategies.get(roleKey)?.strategy ?? MergeStrategy.Union;
    }

    /** Signum's AuthLogic.GetDefaultAllowed — the allowed value a role gets for a resource with no rule. */
    export async function getDefaultAllowed(roleKey: string): Promise<boolean> {
        return (await roleGraph()).mergeStrategies.get(roleKey)?.defaultAllowed ?? false;
    }

    /** Roles in dependency order (parents first) — Signum's RolesInOrder. */
    export async function rolesInOrder(includeTrivialMerge = true): Promise<string[]> {
        const g = await roleGraph();
        return includeTrivialMerge ? g.order : g.order.filter(k => !g.rolesByKey.get(k)!.isTrivialMerge);
    }

    /** The current user's role key from the claims bag (Signum's RoleEntity.Current), or undefined. */
    export function currentRoleKey(): string | undefined {
        const role = UserHolder.current()?.getClaim("Role") as Lite<RoleEntity> | undefined;
        return role?.key();
    }
}
