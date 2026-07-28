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
