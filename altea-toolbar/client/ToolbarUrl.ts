import { Dic } from "@altea/altea/data/globals";
import { cleanTypeName } from "@altea/altea/data/registration";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import * as AppContext from "@altea/altea/client/AppContext";

// Faithful port of Signum's ToolbarUrl.ts (Signum.Toolbar/ToolbarUrl.ts): the placeholder substitution a
// toolbar element's raw `url` goes through before navigation.
//
//   /order/:id            → the selected entity's id           (an entity-scoped ToolbarMenu)
//   /:type/:id            → its clean type name + id
//   /view/:key            → its lite key ("Order;3")
//   /report/:toStr        → its sanitised toString
//   …:id2 / :type2 / :key2 / :toStr2 → a SECOND, config-chosen entity (see ToolbarConfig.selectSubEntityForUrl)
//   $variables$           → app-registered dynamic values (registerUrlVariable)
//
// altea divergences:
//  - `liteKey(lite)` / `getToString(lite)` are METHODS on altea's Lite (`lite.key()` / `lite.toString()`).
//  - `isExternalLink` compared against Signum's `window.__baseName`; altea keeps the base name in
//    AppContext (`baseName`), so the origin+base prefix is built from there.

export namespace ToolbarUrl {

    export function replaceVariables(url: string): string {
        Dic.getKeys(urlVariables).forEach(v => {
            url = url.replaceAll(v, urlVariables[v]());
        });
        return url;
    }

    /** Signum's `urlVariables`: app-registered `$name$` → value producers. */
    export const urlVariables: { [name: string]: () => string } = {};

    export function registerUrlVariable(name: string, getValue: () => string): void {
        urlVariables[name] = getValue;
    }

    export function replaceEntity(url: string, selectedEntity: Lite<Entity>): string {
        return url
            .replaceAll(":id", selectedEntity.id!.toString())
            .replace(":type", cleanTypeName(selectedEntity.entityType))
            .replace(":key", selectedEntity.key())
            .replace(":toStr", selectedEntity.toString().replace(/[^a-zA-Z0-9-_]/g, ""));
    }

    export function hasSubEntity(url: string): boolean {
        return url.includes(":type2") || url.includes(":id2") || url.includes(":key2");
    }

    export function replaceSubEntity(url: string, subEntity: Lite<Entity>): string {
        return url
            .replaceAll(":id2", subEntity.id!.toString())
            .replace(":type2", cleanTypeName(subEntity.entityType))
            .replace(":key2", subEntity.key())
            .replace(":toStr2", subEntity.toString().replace(/[^a-zA-Z0-9-_]/g, ""));
    }

    export function isExternalLink(url: string): boolean {
        return url.startsWith("http") && !url.startsWith(window.location.origin + AppContext.toAbsoluteUrl("/"));
    }
}
