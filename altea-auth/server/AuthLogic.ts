import "@altea/altea/server"; // installs Entity.save()/delete()
import { type FluentStateMachine } from "@altea/altea/server/fluentOperations";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import { AsyncLocalStorage } from "node:async_hooks";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { DirectedGraph } from "@altea/altea/server/directedGraph";
import { UserHolder } from "@altea/altea/server/userHolder";
import { Temporal, toInt } from "@altea/altea/data/basics";
import { Lite } from "@altea/altea/data/lite";
import { UserWithClaims } from "@altea/altea/data/security";
import { PasswordEncoding } from "@altea/altea/server/passwordEncoding";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { ResetLazy } from "@altea/altea/data/resetLazy";
import { codify } from "@altea/altea/server/sync/stringHash";
import { UserEntity, UserState, UserOperation } from "../data/User";
import { RoleEntity, RoleEntity_InheritsFrom, RoleOperation, MergeStrategy } from "../data/Role";
import { UserMessage, LoginAuthMessage } from "../data/AuthMessages";
import type { AuthImportCtx } from "./AuthRulesXml";
// NOTE: AuthServer imports back from AuthLogic — a runtime-only cycle (both sides use the other only
// inside functions, never at module-eval), so ESM resolves it fine. AuthServer is invoked lazily from
// start() below, guarded by sb.webBuilder.
import { AuthServer } from "./AuthServer";

// Port of Signum.Authorization's AuthLogic.cs — see port/Auth.md.
//
// The AUTHENTICATION half (login, the user state machine, the system / anonymous users) plus the ROLE
// GRAPH every authorization dimension folds its rules over.
//
// Counter and hash writes go through `user.save()` directly rather than a Save operation.

/** The pluggable login seam (AD / OpenID). */
export interface ICustomAuthorizer {
    login(username: string, password: string): Promise<{ user: UserEntity; authenticationType: string }>;
}

// The specific login exceptions — the controller maps each to a field error.
export class IncorrectUsernameException extends Error { constructor(message?: string) { super(message); this.name = "IncorrectUsernameException"; } }
export class IncorrectPasswordException extends Error { constructor(message?: string) { super(message); this.name = "IncorrectPasswordException"; } }
export class UserLockedException extends Error { constructor(message?: string) { super(message); this.name = "UserLockedException"; } }

export namespace AuthLogic {
    // Modules hook post-login side effects.
    export const userLogingIn: ((user: UserEntity, loginMethod: string) => void)[] = [];

    // When set, the controller delegates login to it.
    export let authorizer: ICustomAuthorizer | null = null;

    // Lock the user after this many consecutive failures.
    export let maxFailedLoginAttempts: number | null = null;

    // Invoked JUST BEFORE the failed-attempt lockout
    // deactivates the user, so a module can react (@altea/altea-auth-reset-password mails the user a
    // reset link). Async here (altea's mail send is), and awaited by the lockout path below.
    export let onDeactivateUser: ((user: UserEntity) => Promise<void> | void) | null = null;

    // ONE slot, filled by UserTicketLogic.start: a user who can no longer log in must not stay
    // remembered on their devices, and both operations that can cause that call this. So the state
    // machine has no second code path and this module needs no knowledge of tickets. Null — the module
    // not started — means there are no tickets to revoke.
    export let onRemoveUserTickets: ((user: UserEntity) => Promise<number | null>) | null = null;

    // The two user names {@link start} takes. WRITABLE, so a test starter can set one without a restart.
    //
    // `anonymousUserName` is the app's whole unauthenticated posture in one string. With it SET, a request
    // carrying no token is authenticated AS that user (see AuthServer.authenticate's fallback), so it
    // passes the gate on EVERY route and is limited only by that user's role rules. With it NULL, such a
    // request has no user at all and the gate rejects it unless the route is `allowAnonymous`.
    export let systemUserName: string | null = null;
    export let anonymousUserName: string | null = null;

    /**
     * The user a trusted internal flow runs as.
     *
     * The read is AUTHORIZATION-SUPPRESSED, and that is the whole point. It resolves per call through the
     * ordinary gated `retrieveUserByUsername`, so without the suppression the CALLER's own rights decide
     * whether the system user can be found: under the anonymous role (no rules → None) the read comes back
     * empty, `asSystemUser` falls through to its no-op branch, and the block runs as ANONYMOUS — silently,
     * which is the dangerous half, because its callers are precisely the ones that must NOT be subject to
     * the current caller's rights (the login failed-counter writes, an anonymous self-registration).
     */
    export async function systemUser(): Promise<UserEntity | null> {
        return systemUserName == null ? null : await withDisabled(() => retrieveUserByUsername(systemUserName!));
    }

    /**
     * The user an unauthenticated request runs as. CACHED, because with an anonymous user configured this
     * is on the path of EVERY request that carries no token — an uncached read is one extra SELECT per
     * anonymous page view. The lazy is registered on the schema builder rather than created here, so
     * `AuthLogic.resetLazies()` and the cache panel see it like every other one.
     */
    export async function anonymousUser(): Promise<UserEntity | null> {
        if (anonymousUserName == null)
            return null;
        return await anonymousUserLazy.value();
    }

    // `withDisabled` runs `fn` with authorization SUPPRESSED for its async-propagated scope — the
    // row-read filter, the save gate and isAllowedFor all short-circuit to "allowed". Used by trusted
    // internal flows (changePassword, the login failed-counter writes) that must bypass the current role's
    // rules. Backed by an AsyncLocalStorage, so it holds across awaited work inside `fn`, like UserHolder.
    const disabledStorage = new AsyncLocalStorage<boolean>();
    export function withDisabled<R>(fn: () => R): R {
        return disabledStorage.run(true, fn);
    }
    export function isEnabled(): boolean {
        // The GLOBAL check is folded in here rather than repeated at every call: a GlobalLazy factory runs
        // in ExecutionMode.global (SchemaBuilder.globalLazy), so its cache-loading queries see auth
        // suppressed — which is also what breaks the recursion where the row filter's own rule load would
        // re-enter the queryFilter provider.
        return disabledStorage.getStore() !== true && !ExecutionMode.isInGlobal();
    }

    /**
     * Both names are OPTIONAL, so an app or a test starter that wants neither still reads as
     * `AuthLogic.start(sb)`.
     */
    export function start(sb: SchemaBuilder, systemUser?: string | null, anonymousUser?: string | null): void {
        systemUserName = systemUser ?? null;
        anonymousUserName = anonymousUser ?? null;

        // `UserState.New` is the state of a user being CREATED, never stored, so it must not become a row
        // of the enum table.

        // (The Role / ExternalId claim FILLERS live in data/User.ts: a UserWithClaims is built on the
        // CLIENT too, and a filler declared in the data layer serves both tiers.)

        sb.include(RoleEntity)
            .withSave(RoleOperation.Save)
            .withDelete(RoleOperation.Delete)
            .withQuery();

        sb.include(UserEntity)
            // The deactivation sweep filters on it.
            .withIndex(u => u.disabledOn)
            .withStateMachine(u => u.state, registerUserOperations)
            .withQuery();

        // The role graph is a globalLazy invalidated by RoleEntity. Its factory runs in
        // ExecutionMode.global, so the RoleEntity read is UNGATED — no explicit withDisabled, and no
        // re-entry into the row-filter provider.
        roleGraphLazy = sb.globalLazy(() => loadRoleGraph(), { invalidateWith: [RoleEntity] });

        // Invalidated by a UserEntity save, so renaming or re-roling the anonymous user takes effect
        // without a restart. (Signum's is WithoutInvalidations, i.e. never.)
        anonymousUserLazy = sb.globalLazy(async () => {
            const user = await retrieveUserByUsername(anonymousUserName!);
            if (user == null)
                throw new Error(`AnonymousUser with name '${anonymousUserName}' not found`);
            return user;
        }, { invalidateWith: [UserEntity], name: "AnonymousUser" });

        // When the host set a web
        // builder on the SchemaBuilder, wire the whole auth HTTP surface (authentication middleware +
        // /api/auth, the role-filtered reflection blob, and the /api/authAdmin rule-pack routes). A
        // terminal / test build leaves webBuilder undefined, so no HTTP is mounted.
        if (sb.webBuilder)
            AuthServer.start(sb.webBuilder);
    }

    // A SWAPPABLE slot. Exact-match on userName: usernames are case-SENSITIVE here, where Signum
    // lowercases both sides.
    export let retrieveUserByUsername: (username: string) => Promise<UserEntity | null> =
        (username) => table(UserEntity).filter(u => u.userName == username).singleOrNull() as Promise<UserEntity | null>;

    // Resolve, and reject a deactivated user outright.
    export async function retrieveUser(username: string): Promise<UserEntity | null> {
        const user = await retrieveUserByUsername(username);
        if (user != null && user.state === UserState.Deactivated)
            throw new UserLockedException(LoginAuthMessage.User0IsDeactivated.niceToString(user.userName));
        return user;
    }

    export function checkUserActive(user: UserEntity): void {
        if (user.state !== UserState.Active)
            throw new UnauthorizedAccessException(UserMessage.UserIsNotActive.niceToString());
    }

    // Hash, then delegate to the hash-comparing retrieve.
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

    // The password-checking core: the failed-counter / lockout handling and the on-success hash upgrade.
    async function retrieveUserAndCheckPassword(username: string, passwordHash: Buffer, alternatives: Buffer[]): Promise<UserEntity> {
        // Disabling authorization here is NOT optional: a login request is by definition not yet
        // authenticated, so it runs as whatever the anonymous fallback gives it. With an ANONYMOUS USER
        // configured that is a real role — one that cannot read UserEntity — so without this the lookup
        // below finds nothing and EVERY login fails with "is not valid". (It is latent while no app
        // configures one: with no user at all there is no role, and every gate short-circuits.) The scope
        // covers the failed-counter writes too.
        return await withDisabled(() => checkPasswordCore(username, passwordHash, alternatives));
    }

    async function checkPasswordCore(username: string, passwordHash: Buffer, alternatives: Buffer[]): Promise<UserEntity> {
        const user = await retrieveUser(username);
        if (user == null)
            throw new IncorrectUsernameException(LoginAuthMessage.Username0IsNotValid.niceToString(username));

        const stored = decodeHash(user.passwordHash);
        const candidates = [passwordHash, ...alternatives];
        const matches = stored != null && candidates.some(c => PasswordEncoding.sequenceEqual(c, stored));

        if (!matches) {
            // Written as the SYSTEM user rather than as the half-authenticated caller.
            user.loginFailedCounter++;
            await asSystemUser(() => user.save());

            if (maxFailedLoginAttempts != null && user.loginFailedCounter >= maxFailedLoginAttempts && user.state === UserState.Active) {
                // BEFORE the state flips, so a handler still
                // sees an Active user (altea-auth-reset-password mails a reset link from here).
                if (onDeactivateUser != null)
                    await onDeactivateUser(user);
                user.disabledOn = Temporal.Now.plainDateTimeISO();
                user.state = UserState.Deactivated;
                await asSystemUser(() => user.save());
                throw new UserLockedException(LoginAuthMessage.User0IsDeactivated.niceToString(user.userName));
            }
            throw new IncorrectPasswordException(LoginAuthMessage.IncorrectPassword.niceToString());
        }

        if (user.loginFailedCounter > 0) {
            user.loginFailedCounter = toInt(0);
            await asSystemUser(() => user.save());
        }

        // Upgrade a legacy (alternative) hash to the primary scheme on successful login (store the raw
        // primary-hash bytes if the stored bytes differ).
        if (user.passwordHash == null || !PasswordEncoding.sequenceEqual(Buffer.from(user.passwordHash), passwordHash)) {
            user.passwordHash = passwordHash;
            await asSystemUser(() => user.save());
        }

        return user;
    }

    /**
     * Run `fn` as the configured system user.
     * With none configured the scope is a NO-OP: the write stays attributed to whoever is current.
     *
     * EXPORTED because an application needs it too: an ANONYMOUS endpoint that writes (eastwind's
     * self-service user registration, Southwind's `PublicController.RegisterUser`) has no user of its own
     * to attribute the rows to, and running as the system user is what makes them auditable rather than
     * ownerless. It is deliberately NOT `withDisabled`: the system user's own role still applies, so an
     * anonymous route cannot write more than that role may.
     */
    export async function asSystemUser<R>(fn: () => Promise<R>): Promise<R> {
        // No system user CONFIGURED — the scope is a no-op. Configured but MISSING is a different thing:
        // a deployment error, and degrading silently would run a trusted block as whoever happened to be
        // current. Say so, the way the anonymous-user lazy already does for its own name.
        if (systemUserName == null)
            return await fn();

        const system = await systemUser();
        if (system == null)
            throw new Error(`SystemUser with name '${systemUserName}' not found`);

        return await UserHolder.withUser(new UserWithClaims(system), fn);
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

// The user activation state machine. Deactivate / AutoDeactivate revoke the user's remembered devices
// through `onRemoveUserTickets` (see the slot). There is no "recently disabled users" cache to invalidate
// beside it: that is an auth-TOKEN concern here — see AuthTokenServer.
function registerUserOperations(sm: FluentStateMachine<UserEntity, UserState>): void {
    sm.withConstruct(UserOperation.Create, {
        toStates: [UserState.New],
        construct: () => UserEntity.create({ state: UserState.New }),
    });

    sm.withExecute(UserOperation.Save, {
        fromStates: [UserState.Active, UserState.New],
        toStates: [UserState.Active],
        canBeNew: true,
        canBeModified: true,
        execute: async u => {
            u.state = UserState.Active;
            // passwordHash is @serialize(false), so a client-originated save carries none. altea UPDATEs
            // every column, so re-load the stored hash for an existing user to avoid nulling it out
            // New users get their hash set elsewhere (the seed, or the DoublePassword flow).
            if (!u.isNew && u.passwordHash == null) {
                const stored = await table(UserEntity).filter(x => x.id == u.id).singleOrNull() as UserEntity | null;
                if (stored != null)
                    u.passwordHash = stored.passwordHash;
            }
        },
    });

    sm.withExecute(UserOperation.Deactivate, {
        fromStates: [UserState.Active],
        toStates: [UserState.Deactivated],
        execute: async u => {
            u.disabledOn = Temporal.Now.plainDateTimeISO();
            u.state = UserState.Deactivated;
            // The state is set FIRST: removeTickets only acts on a user who is no longer Active, which is
            // what a handler firing after the assignment would see.
            await AuthLogic.onRemoveUserTickets?.(u);
        },
    });

    sm.withExecute(UserOperation.AutoDeactivate, {
        fromStates: [UserState.Active],
        toStates: [UserState.AutoDeactivate],
        execute: async u => {
            u.disabledOn = Temporal.Now.plainDateTimeISO();
            u.state = UserState.AutoDeactivate;
            await AuthLogic.onRemoveUserTickets?.(u);
        },
    });

    sm.withExecute(UserOperation.Reactivate, {
        fromStates: [UserState.Deactivated, UserState.AutoDeactivate],
        toStates: [UserState.Active],
        execute: u => {
            u.disabledOn = null;
            u.state = UserState.Active;
        },
    });

    sm.withDelete(UserOperation.Delete, {
        fromStates: [UserState.Deactivated, UserState.AutoDeactivate, UserState.Active],
        delete: u => u.delete(),
    });
}

// ---- Role graph ---------------------------------------------------------------------------------
//
// The inherit / merge DAG every authorization cache folds rules over: ONE async-loaded, reset-able
// snapshot (`invalidateRoles()` drops it), where Signum keeps three separate lazies. Roles are keyed by
// their Lite KEY STRING ("Role;<id>"), so the DirectedGraph uses value identity — a Lite instance is not
// reference-stable.

// The loaded role graph — Signum's RolesByLite/rolesGraph/mergeStrategies GlobalLazys as ONE immutable
// snapshot with SYNCHRONOUS folding accessors (relatedTo/getMergeStrategy/getDefaultAllowed). Every
// authorization cache holds one of these and folds its rules over it synchronously (no per-lookup await).
export class RoleGraph {
    constructor(
        readonly rolesByKey: Map<string, RoleEntity>,
        readonly graph: DirectedGraph<string>,
        // Per role: its merge strategy + the DEFAULT-allowed flag (Union → any base allowed; Intersection →
        // all base allowed; a root role → false for Union, true for Intersection).
        readonly mergeStrategies: Map<string, { strategy: MergeStrategy; defaultAllowed: boolean }>,
        readonly order: string[], // compilation order (parents before children)
    ) { }

    /** Direct inherited roles of `roleKey`. Keys, not entities. */
    relatedTo(roleKey: string): Set<string> {
        return this.graph.tryRelatedTo(roleKey);
    }
    getMergeStrategy(roleKey: string): MergeStrategy {
        return this.mergeStrategies.get(roleKey)?.strategy ?? MergeStrategy.Union;
    }
    /** The allowed value a role gets for a resource with no rule. */
    getDefaultAllowed(roleKey: string): boolean {
        return this.mergeStrategies.get(roleKey)?.defaultAllowed ?? false;
    }
    /** Roles in dependency order, parents first. */
    rolesInOrder(includeTrivialMerge = true): string[] {
        return includeTrivialMerge ? this.order : this.order.filter(k => !this.rolesByKey.get(k)!.isTrivialMerge);
    }
}

// AuthRules XML import / export delegation.
// Each authorization dimension registers a handler in its start(); AuthImportExport orchestrates
// (writes the <Roles> block + assembles/parses the document, reconciles role + resource renames centrally).
export interface AuthExportCtx {
    orderedRoleKeys: string[];             // roles in dependency order (parents first)
    roleName(key: string): string;
}
// An exporter returns its section's name (the XML element, e.g. "Types") + the section content object for
// the XMLBuilder. An importer reads its section off the parsed `auth` object and applies it.
export type AuthXmlExporter = (ctx: AuthExportCtx) => Promise<{ name: string; content: unknown }>;
export type AuthXmlImporter = (auth: Record<string, unknown>, ctx: AuthImportCtx) => Promise<void>;
const exporterList: AuthXmlExporter[] = [];
const importerList: AuthXmlImporter[] = [];

// An async, reset-able snapshot created in AuthLogic.start (invalidateWith RoleEntity). Its factory runs
// in ExecutionMode.global.
let roleGraphLazy: ResetLazy<RoleGraph>;
let anonymousUserLazy: ResetLazy<UserEntity>;

async function loadRoleGraph(): Promise<RoleGraph> {
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

    return new RoleGraph(rolesByKey, graph, mergeStrategies, order);
}

export namespace AuthLogic {
    /** The loaded role-graph snapshot. Its factory runs in ExecutionMode.global, so the RoleEntity read
     *  is ungated. */
    export async function roleGraph(): Promise<RoleGraph> {
        return roleGraphLazy.value();
    }

    /** Drop the cached role graph. A RoleEntity save auto-invalidates through the lazy, so this is for
     *  out-of-band callers — a set-based role delete. */
    export function invalidateRoles(): void {
        roleGraphLazy?.reset();
    }

    // Async convenience wrappers over the loaded RoleGraph, for callers outside a cache (import /
    // export). The authorization caches instead HOLD the RoleGraph and fold synchronously via its
    // methods.
    export async function relatedTo(roleKey: string): Promise<Set<string>> {
        return (await roleGraph()).relatedTo(roleKey);
    }
    export async function getMergeStrategy(roleKey: string): Promise<MergeStrategy> {
        return (await roleGraph()).getMergeStrategy(roleKey);
    }
    export async function getDefaultAllowed(roleKey: string): Promise<boolean> {
        return (await roleGraph()).getDefaultAllowed(roleKey);
    }
    export async function rolesInOrder(includeTrivialMerge = true): Promise<string[]> {
        return (await roleGraph()).rolesInOrder(includeTrivialMerge);
    }

    /**
     * Resolve a user AND check the password,
     * returning null instead of throwing and WITHOUT touching the failed-login counter. Used by a
     * directory authorizer to try the local database first (a DB round-trip beats an LDAP bind), so a
     * failed probe must not count as a failed login attempt.
     */
    export async function tryRetrieveUser(username: string, password: string): Promise<UserEntity | null> {
        return await withDisabled(async () => {
            const user = await retrieveUserByUsername(username);
            if (user == null)
                return null;

            const stored = decodeHash(user.passwordHash);
            if (stored == null)
                return null;

            const candidates = [
                PasswordEncoding.hashPassword(username, password),
                ...PasswordEncoding.hashPasswordAlternatives(username, password),
            ];
            return candidates.some(c => PasswordEncoding.sequenceEqual(c, stored)) ? user : null;
        });
    }

    /**
     * A directory user may match SEVERAL
     * `roleMapping` entries, and a user points at exactly ONE role, so the N roles are represented by a
     * synthetic "trivial merge" role that just inherits from all of them (Union). Idempotent: the name is
     * derived from the flattened set, so the same set always resolves to the same role.
     *
     * altea divergences:
     *  - there is no separate by-name lazy: the ONE loaded RoleGraph is scanned by name, since the role
     *    count is small and the graph is already in memory.
     *  - the trivial-merge NAME is computed here rather than on the isomorphic RoleEntity: it needs
     *    `codify` (server/sync/stringHash), which is server-only.
     *  - `withDisabled` + `ExecutionMode.global` is the whole trusted scope.
     */
    export async function getOrCreateTrivialMergeRole(roles: Lite<RoleEntity>[]): Promise<Lite<RoleEntity>> {
        const distinct = dedupLites(roles);
        if (distinct.length === 0)
            throw new Error("getOrCreateTrivialMergeRole: no roles given");
        if (distinct.length === 1)
            return distinct[0]!;

        const graph = await roleGraph();

        // Flatten: a trivial-merge role contributes the roles it inherits from, not itself — so merging
        // {A, merge(B,C)} yields merge(A,B,C) rather than a merge of a merge.
        const flat = dedupLites(distinct.flatMap(lite => {
            const role = graph.rolesByKey.get(lite.key());
            return role != null && role.isTrivialMerge
                ? role.inheritsFrom.map(row => row.inheritsFrom)
                : [lite];
        }));

        if (flat.length === 1)
            return flat[0]!;

        const name = calculateTrivialMergeName(flat);

        const existing = [...graph.rolesByKey.values()].find(r => r.name === name);
        if (existing != null)
            return existing.toLite() as Lite<RoleEntity>;

        return await withDisabled(() => ExecutionMode.global(async () => {
            const created = RoleEntity.create({
                name,
                mergeStrategy: MergeStrategy.Union,
                description: null,
                isTrivialMerge: true,
                inheritsFrom: flat.map(l => RoleEntity_InheritsFrom.create({ inheritsFrom: l })),
            });
            await created.save();
            invalidateRoles();
            return created.toLite() as Lite<RoleEntity>;
        }));
    }

    /** A deterministic, ≤200-char name for a role set. */
    export function calculateTrivialMergeName(roles: Lite<RoleEntity>[]): string {
        const name = roles.map(a => a.toString()).sort().join(" + ");
        const full = codify(name, /* lowercase */ false) + ": " + name;
        return full.length <= 200 ? full : full.substring(0, 197) + "...";
    }

    /** The current user's role key, or undefined. */
    export function currentRoleKey(): string | undefined {
        return RoleEntity.current()?.key();
    }

    /** The current user's role lite, or null. Both read the claims bag through `RoleEntity.current()`,
     *  the isomorphic accessor — one claim read, one place. */
    export function currentRoleLite(): Lite<RoleEntity> | null {
        return RoleEntity.current();
    }

    /**
     * The current role AND every role it (transitively) inherits
     * from, as lites. The set an owner-scoped TypeCondition compares a "shared" asset's owner against
     * (`d.owner == null || currentRoles().includes(d.owner)`).
     *
     * SYNCHRONOUS on purpose: it is called from inside a TypeCondition's `@quoted` lambda, which the LINQ
     * binder folds to a constant while BUILDING the query (no await possible) and which also runs in memory
     * per entity. It therefore reads the ALREADY-LOADED role graph. Before the
     * graph is warm only the current role itself is returned — fail-CLOSED (fewer assets visible), and the
     * graph is warm from the first authorization check of a request.
     */
    export function currentRoles(): Lite<RoleEntity>[] {
        const current = currentRoleLite();
        if (current == null)
            return [];

        const graph = roleGraphLazy?.valueOrUndefined;
        if (graph == null)
            return [current];

        // Transitive closure of `relatedTo` (the inherited-from edges), INCLUDING the starting role.
        const keys = new Set<string>();
        const pending = [current.key()];
        while (pending.length > 0) {
            const key = pending.pop()!;
            if (keys.has(key))
                continue;
            keys.add(key);
            for (const related of graph.relatedTo(key))
                if (!keys.has(related))
                    pending.push(related);
        }

        return [...keys].map(k => graph.rolesByKey.get(k)?.toLite() as Lite<RoleEntity> | undefined)
            .filter((l): l is Lite<RoleEntity> => l != null);
    }

    /**
     * Every role that (transitively) INHERITS `role`,
     * including `role` itself. The inverse direction of `currentRoles`: "who counts as this role" rather
     * than "what does this role count as".
     *
     * Added for @altea/altea-workflow, whose lane actors may be ROLES: the users notified for an activity are
     * the users whose role is, or inherits, one of the lane's actor roles. ASYNC (it awaits the role graph),
     * unlike `currentRoles` — a notification insert is not inside a query lambda.
     */
    export async function rolesInheritingFrom(role: Lite<RoleEntity>): Promise<Lite<RoleEntity>[]> {
        const graph = await roleGraphLazy.value();
        const inverse = graph.graph.inverse();

        const keys = new Set<string>();
        const pending = [role.key()];
        while (pending.length > 0) {
            const key = pending.pop()!;
            if (keys.has(key))
                continue;
            keys.add(key);
            for (const related of inverse.tryRelatedTo(key))
                pending.push(related);
        }

        return [...keys].map(k => graph.rolesByKey.get(k)?.toLite() as Lite<RoleEntity> | undefined)
            .filter((l): l is Lite<RoleEntity> => l != null);
    }

    /** Register a dimension's AuthRules XML export / import handler. Called from each *AuthLogic.start();
     *  AuthImportExport invokes them. */
    export function registerXmlExporter(exporter: AuthXmlExporter): void { exporterList.push(exporter); }
    export function registerXmlImporter(importer: AuthXmlImporter): void { importerList.push(importer); }
    export function xmlExportersInOrder(): AuthXmlExporter[] { return exporterList; }
    export function xmlImporters(): AuthXmlImporter[] { return importerList; }
}

// Lite de-duplication by key (a Lite instance is not reference-stable, so `[...new Set(lites)]` would
// keep duplicates). Used by getOrCreateTrivialMergeRole.
function dedupLites<T extends { key(): string }>(lites: T[]): T[] {
    const seen = new Map<string, T>();
    for (const l of lites)
        if (!seen.has(l.key()))
            seen.set(l.key(), l);
    return [...seen.values()];
}
