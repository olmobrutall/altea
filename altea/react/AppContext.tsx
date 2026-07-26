// Ported from Signum.React/AppContext.tsx — MINIMAL SLICE.
// Only `toAbsoluteUrl` is needed by the first migrated files (Services). The rest of
// AppContext (routing history, current-user context, ScrollRestoration, view-related
// helpers) will be filled in during the Navigator phase. Kept at this path + PascalCase
// so the copied Signum client files' `import ... from './AppContext'` resolve unchanged.

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
