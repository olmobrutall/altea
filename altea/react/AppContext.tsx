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

// Signum's AppContext.navigate: SPA navigation via the router history. altea hasn't wired a shared
// history object yet, so this is a hard-navigation fallback (full page load). TODO(port): route it
// through the react-router navigate once AppContext owns the history.
export function navigate(url: string): void {
  window.location.assign(toAbsoluteUrl(url));
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
