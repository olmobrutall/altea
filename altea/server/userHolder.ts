import { AsyncLocalStorage } from "node:async_hooks";
import { CurrentUser, type IUserEntity, type UserWithClaims } from "../data/security";

// Port of Signum's UserHolder (Signum/Security/IUserEntity.cs). The server-side "who is the current
// user" holder. Signum backs it with a session variable + an OverrideSession scope; altea (server-only,
// like systemTime.ts) backs it with a Node AsyncLocalStorage so concurrent requests each get their own
// current user without cross-talk.
//
// Usage: the auth middleware opens a per-request scope with `withScope(fn)` (the OverrideSession
// analogue), then the token/login authenticator calls `setCurrent(user)` inside it. Reads go through
// `current()` (Signum's UserHolder.Current). `withUser(user, fn)` is the one-shot convenience
// (Signum's `using (UserHolder.UserSession(user))`), used by background/seed code that runs outside a
// request.

// A mutable box so code INSIDE a scope can (re)assign the current user (login sets it after
// authenticating). AsyncLocalStorage stores the box; the box holds the value.
interface UserBox { value: UserWithClaims | undefined; }

const storage = new AsyncLocalStorage<UserBox>();

export namespace UserHolder {
    export const userSessionKey = "user";

    // Signum's `static event Action? CurrentUserChanged` — fired whenever the current user is set.
    export const currentUserChanged: (() => void)[] = [];

    /** Signum's UserHolder.Current getter — the current user, or undefined outside any scope. */
    export function current(): UserWithClaims | undefined {
        return storage.getStore()?.value;
    }

    /** Signum's UserHolder.Current setter — assign the current user within the active scope. Throws if
     *  called outside a `withScope` (mirrors the server's no-ambient-mutation rule). */
    export function setCurrent(user: UserWithClaims | undefined): void {
        const box = storage.getStore();
        if (box == null)
            throw new Error("UserHolder.setCurrent must be called inside a UserHolder.withScope (open one per request)");
        box.value = user;
        for (const fn of currentUserChanged)
            fn();
    }

    /** Open a fresh per-request user scope (Signum's ScopeSessionFactory.OverrideSession). The current
     *  user starts undefined; an authenticator calls setCurrent inside `fn`. */
    export function withScope<R>(fn: () => R): R {
        return storage.run({ value: undefined }, fn);
    }

    /** Signum's `using (UserHolder.UserSession(user))` — run `fn` with `user` as the current user. */
    export function withUser<R>(user: UserWithClaims, fn: () => R): R {
        return storage.run({ value: user }, fn);
    }

    /** The current user's Lite, or null (used to stamp ExceptionEntity.user / OperationLogEntity.user). */
    export function currentUserLite(): import("../data/lite").Lite<IUserEntity> | null {
        return current()?.user ?? null;
    }
}

// The SERVER's half of the isomorphic `CurrentUser` accessor (data/security): every `UserEntity.current()`
// / `RoleEntity.current()` / app `EmployeeEntity.current()` on this tier resolves through the request scope
// above. Installed at module load — the data layer declares the accessors, each tier says where the user
// comes from.
CurrentUser.setProvider(() => UserHolder.current());
