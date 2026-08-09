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
import type { IUserEntity } from "../data/security";

export let currentUser: IUserEntity | undefined = undefined;

export const currentUserChanged: (() => void)[] = [];

export function setCurrentUser(user: IUserEntity | undefined): void {
  currentUser = user;
  currentUserChanged.forEach(a => a());
}

// App-shell re-render hook (Signum's `AppContext.resetUI` / `setResetUI`). A single settable function:
// the app shell (MainPublic) registers one that re-renders the tree so components re-read currentUser
// (the login/logout/switch-user transition); callers (AuthClient, ChangePasswordPage) invoke it.
//
// NOTE: resetUI does NOT wipe clientState. Finder REGISTRATIONS (query settings) live in clientState
// (unlike Navigator's module-global entitySettings), so wiping it on every login/reload would drop the
// per-entity defaultColumns/filters registered once at boot. Cache invalidation on a ROLE change (where
// role-filtered settings genuinely must be recomputed) is an authorization-phase concern; when it lands
// it must RE-REGISTER, not just clear. For now resetUI only re-renders.
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
export let _internalRouter: { navigate(to: string, opts?: { replace?: boolean }): void | Promise<void> } | undefined;
export function setRouter(r: { navigate(to: string, opts?: { replace?: boolean }): void | Promise<void> }): void {
  _internalRouter = r;
}

// Signum's AppContext.navigate: SPA navigation via the router. If setRouter() has run we route through
// the react-router DataRouter (fast, no full page reload); otherwise fall back to a hard navigation.
// `replace: true` swaps the current history entry instead of pushing a new one (used by SearchPage's
// URL sync so each in-place search doesn't stack a back-button entry).
export function navigate(url: string, options?: { replace?: boolean }): void {
  const to = toAbsoluteUrl(url);
  if (_internalRouter)
    _internalRouter.navigate(to, options);
  else if (options?.replace)
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
