import * as React from 'react';

// Ported from Signum.React/AppContext.tsx — MINIMAL SLICE.
// Only `toAbsoluteUrl` is needed by the first migrated files (Services). The rest of
// AppContext (routing history, current-user context, ScrollRestoration, view-related
// helpers) will be filled in during the Navigator phase. Kept at this path + PascalCase
// so the copied Signum client files' `import ... from './AppContext'` resolve unchanged.

// ---- Per-user client state (altea divergence from Signum's `clearSettingsActions`) --------------
//
// Signum reset per-module client caches (query settings, format rules, description cache, …) through
// a global `clearSettingsActions: (() => void)[]` that every module pushed a callback onto and that
// ran on login/reload. altea instead keeps ONE `clientState` object: each client module AUGMENTS
// `IClientState` (declaration merging) with its own slice and stores its mutable state there. On a
// credential change, MainPublic.tsx calls `newClientState()` to reset EVERY module's state at once —
// no callback registry, and a module can't forget to register its reset.
//
//   // in Finder.tsx:
//   declare module "./AppContext" { interface IClientState { finder?: FinderClientState; } }
//   function finderState() { return AppContext.clientState.finder ??= { querySettings: {}, ... }; }
export interface IClientState { }

export let clientState: IClientState = {} as IClientState;

/** Reset all client-module state (call on login / credential change). */
export function newClientState(): void {
  clientState = {} as IClientState;
}

// ---- Current user (Signum's AppContext.currentUser / setCurrentUser / resetUI) -------------------
//
// The single biggest client-side auth hook: the whole SPA reads "who is logged in" from here.
// `currentUser` is typed as the isomorphic IUserEntity marker so the core client never depends on
// altea-auth's concrete UserEntity — AuthClient (in altea-auth) sets/reads the real UserEntity through
// it. `setCurrentUser` fires `currentUserChanged` listeners (e.g. the header LoginDropdown re-renders);
// `resetUI` wipes per-module client state and asks the app shell to remount (login / logout / switch
// user), the altea analogue of Signum's `AppContext.resetUI()`.
import { CurrentUser, UserWithClaims, type IUserEntity } from "../data/security";

export let currentUser: IUserEntity | undefined = undefined;

export const currentUserChanged: (() => void)[] = [];

// The CLIENT's half of the isomorphic `CurrentUser` accessor (data/security), which is what makes
// `UserEntity.current()` / `RoleEntity.current()` / an app's `EmployeeEntity.current()` answer on this tier
// too — Signum has no client counterpart at all, and reads `AppContext.currentUser` by hand everywhere.
// Rebuilt (not patched) on every assignment below, because building it is what runs `fillClaims`: a claim
// derived from the user — the role, an app's employee — must never outlive the user it was derived from.
let currentUserWithClaims: UserWithClaims | undefined = undefined;
CurrentUser.setProvider(() => currentUserWithClaims);

export function setCurrentUser(user: IUserEntity | undefined): void {
  const same = currentUser != null && user != null
    // Entity identity (same type + same id) — the real comparison, not a hand-rolled key…
    && currentUser.is(user)
    // …plus the row VERSION, so an edit to that user still counts as a change. `ticks` is exactly the
    // "has this row changed" stamp, and it catches everything a field-by-field check would have to
    // enumerate — a role reassignment above all, which must reach the listeners because the metadata blob
    // is role-filtered.
    && currentUser.ticks === user.ticks;
  currentUser = user;
  currentUserWithClaims = user == null ? undefined : new UserWithClaims(user);
  // Only notify on a REAL change. A periodic token refresh re-fetches the SAME user at the SAME version,
  // and the listeners here are expensive — altea's reloads the whole reflection blob and remounts the app
  // (AuthClient) — so firing then turns a background refresh into a visible storm: remount → new requests
  // → another refresh → … The fresh instance is still adopted above; only the signal is skipped.
  if (!same)
    currentUserChanged.forEach(a => a());
}

// App-shell re-render hook (Signum's `AppContext.resetUI` / `setResetUI`). A single settable function:
// the app shell (MainPublic) registers one that re-renders the tree so components re-read currentUser
// (the login/logout/switch-user transition); callers (AuthClient, ChangePasswordPage) invoke it.
//
// NOTE: resetUI does NOT wipe clientState — `newClientState()` is a separate, deliberate call, and it IS
// altea's `clearAllSettings()`. Every client REGISTRATION lives in a clientState slice, so dropping the
// object drops all of them at once, and the host immediately re-runs its registration bundle (Signum's
// `clearAllSettings()` + `startFull(routes)` inside its `reload()` — see eastwind's MainPublic).
// What lives here today:
//   Navigator      entitySettings; the isViewable / isCreable / isReadonly event lists
//   Finder         querySettings; the four cell/filter RULE lists (SEEDED from FinderRules, so a reset
//                  restores exactly the framework rules); the registered property formatters; the
//                  SearchControl button-bar providers; the two search-page title extension points
//   Operations     operationSettings
//   QuickLinkClient  the global / per-type / dynamic registries AND their derived cache
//   Frames         onWidgets / onEmbeddedWidgets; ButtonBarManager's entity button-bar renderers
//   SearchControl  the contextual-item providers; the manual-sub-token registry
//   Lines          the tasks a MODULE registers (the FRAMEWORK's own are `defaultTasks`, pushed at import
//                  time and never reset — see LineBase for why the two are separate)
//   Services       addContextHeaders
//   extensions     altea-chart's chart button bar, altea-dashboard's page actions, altea-toolbar's and
//                  altea-whats-new's per-type configs, altea-auth's profile-photo url providers,
//                  altea-map's colour-provider factories
// A SUBSCRIPTION list is deliberately NOT here — `currentUserChanged`, `AuthClient.onCurrentUserChanged`,
// `CultureClient.onCultureChanged`, `Navigator.entityChanged`: those are added and removed by whoever
// subscribes (a component's effect, or a module registering once at import), not re-registered per
// credential change. A module that subscribes from its `start()` must therefore make that idempotent — see
// ActiveDirectoryClient.
export let resetUI: () => void = () => { };
export function setResetUI(reset: () => void): void {
  resetUI = reset;
}

// `.after` is an altea String extension (entities/globals/stringExtensions); `__baseName`
// is declared in ./domGlobals.
export function toAbsoluteUrl(appRelativeUrl: string, baseName?: string): string {
  baseName ??= window.__baseName;
  if (appRelativeUrl?.startsWith("/") && baseName != "")
    if (!appRelativeUrl.startsWith(baseName + (baseName.endsWith("\\") ? "" : "/")))
      return baseName + appRelativeUrl;

  if (appRelativeUrl?.startsWith("~/"))
    return baseName + appRelativeUrl.after("~"); // For backwards compatibility

  return appRelativeUrl;
}

// Signum's AppContext._internalRouter: the DataRouter created by createBrowserRouter at boot, stored
// so navigate() can drive SPA (client-side) navigation. eastwind's MainPublic.client calls setRouter()
// right after createBrowserRouter. altea divergence: typed as the minimal `{ navigate }` slice we use
// (react-router doesn't export a stable DataRouter type name across versions).

// Signum passes react-router's own `To` / `NavigateOptions` / `Location`. altea's navigate takes a plain
// string url, so only the OPTIONS and the location shape are modelled — `state` is the piece that matters
// here: it is how a redirect carries where it came from (see NotFound → /auth/login in an app shell), and
// react-router keeps it in history state rather than in the url.
export interface NavigateOptions {
  replace?: boolean;
  state?: any;
}

/** The slice of react-router's `Location` altea reads (the same members Signum's `location()` returns). */
export interface RouterLocation {
  pathname: string;
  search: string;
  hash: string;
  state: any;
  key?: string;
}

export interface AlteaRouter {
  navigate(to: string, opts?: NavigateOptions): void | Promise<void>;
  // The DataRouter's live state. Optional because only `location()` reads it and a host may hand in a
  // hand-rolled router; `location()` says so rather than crashing.
  state?: { location: RouterLocation };
}
export let _internalRouter: AlteaRouter | undefined;
export function setRouter(r: AlteaRouter): void {
  _internalRouter = r;
}

// Signum's AppContext.location(): the CURRENT route, with the baseName stripped off its pathname so what
// comes back is app-relative — which is what a caller stashing it (the NotFound → login redirect) needs, and
// what `navigate` takes back. Throws if no router has been set: a caller asking where it is has no sensible
// fallback answer, and every app calls setRouter at boot.
export function location(): RouterLocation {
  const router = _internalRouter;
  if (router?.state == null)
    throw new Error("AppContext.location() needs a router with live state — was setRouter() called with the DataRouter?");

  const loc = router.state.location;
  return { ...loc, pathname: toRelativeUrl(loc.pathname) };
}

/** The inverse of {@link toAbsoluteUrl} — Signum's private `toRelativeUrl`. */
export function toRelativeUrl(url: string): string {
  if (window.__baseName && url.startsWith(window.__baseName))
    return url.after(window.__baseName);

  if (url.startsWith("~"))
    return url.after("~");

  return url;
}

// Signum's AppContext.navigate: SPA navigation via the router. If setRouter() has run we route through
// the react-router DataRouter (fast, no full page reload); otherwise fall back to a hard navigation.
// `replace: true` swaps the current history entry instead of pushing a new one (used by SearchPage's
// URL sync so each in-place search doesn't stack a back-button entry).
export function navigate(url: string, options?: NavigateOptions): void {
  const to = toAbsoluteUrl(url);
  if (_internalRouter)
    _internalRouter.navigate(to, options);
  else if (options?.replace)
    // No router: a hard navigation cannot carry `state` (it is in-memory history state the SPA reads back),
    // so it is simply dropped — the only caller that passes one is the login redirect, which runs inside the app.
    window.location.replace(to);
  else
    window.location.assign(to);
}

// Ported from Signum.React/AppContext.tsx — sets document.title while the component is mounted.
export function useTitle(title: string, deps?: React.DependencyList): void {
  React.useEffect(() => {
    document.title = title;
  }, deps);
}

// Ported from Signum.React/AppContext.tsx — navigate, or open in a new tab on ctrl/middle-click.
export function pushOrOpenInTab(path: string, e: React.MouseEvent<any> | React.KeyboardEvent<any> | undefined): void {
  if (e && (e as React.MouseEvent<any>).button == 2)
    return;

  e?.preventDefault();
  if (e && (e.ctrlKey || (e as React.MouseEvent<any>).button == 1))
    window.open(toAbsoluteUrl(path));
  else if (path.startsWith("http"))
    window.location.href = path;
  else
    navigate(toAbsoluteUrl(path));
}

// ---- HTML-returning string/array helpers (Signum's Globals `formatHtml`/`joinCommaHtml`/`joinHtml`) --
// The JSX-returning variants of `format`/`joinComma`/`join`: they interleave React nodes as separators
// / placeholder substitutions and return a React element. Client-only (return React nodes), so they
// live here in the react layer — NOT in entities/globals (which must stay React-free). Import this
// module once at client startup to install them (Navigator/Finder/Services already do).
declare global {
  interface String {
    formatHtml(...parameters: any[]): React.ReactElement;
  }

  interface Array<T> {
    joinCommaHtml(this: Array<T>, lastSeparator: string): React.ReactElement;
    joinHtml(this: Array<T>, separator: string | React.ReactElement): React.ReactElement;
  }
}

String.prototype.formatHtml = function (this: string) {
  const regex = /\{([\w-]+)(?:\:([\w\.]*)(?:\((.*?)?\))?)?\}/g;

  const args = arguments;

  const parts = this.split(regex);

  const result: (string | React.ReactElement)[] = [];
  for (let i = 0; i < parts.length - 4; i += 4) {
    result.push(parts[i]);
    result.push(args[parseInt(parts[i + 1])]);
  }
  result.push(parts[parts.length - 1]);

  return React.createElement(React.Fragment, undefined, ...result);
};

Array.prototype.joinCommaHtml = function (this: any[], lastSeparator: string) {
  const result: (string | React.ReactElement)[] = [];
  for (let i = 0; i < this.length - 2; i++) {
    result.push(this[i]);
    result.push(", ");
  }

  if (this.length >= 2) {
    result.push(this[this.length - 2]);
    result.push(lastSeparator)
  }

  if (this.length >= 1) {
    result.push(this[this.length - 1]);
  }

  return React.createElement("span", undefined, ...result);
}

Array.prototype.joinHtml = function (this: any[], separator: string | React.ReactElement) {
  const result: (string | React.ReactElement)[] = [];
  for (let i = 0; i < this.length - 1; i++) {
    result.push(this[i]);
    result.push(separator);
  }

  if (this.length >= 1) {
    result.push(this[this.length - 1]);
  }

  return React.createElement("span", undefined, ...result);
}
