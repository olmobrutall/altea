import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/fluentOperations"; // FluentInclude.withSave / withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { DynamicCSSOverrideEntity, DynamicCSSOverrideOperation } from "../data/DynamicCSSOverride";

// Port of Signum.Dynamic's CSS/DynamicCSSOverrideLogic.cs — the table, its two operations, and the lazy the
// endpoint serves.
//
// THE divergence, and the reason there is an endpoint at all: Signum ships the stylesheet by interpolating
// `DynamicCSSOverrideLogic.Cached` into `Index.cshtml` (its own header block documents the edit an
// application has to make there). altea has no server-rendered page, so the client fetches the concatenated
// text once at boot and appends a <style> element — exactly what altea-auth-azuread / -openid do for their
// browser-visible configuration.
//
// The endpoint is ANONYMOUS, matching Signum's timing rather than tightening it: the stylesheet is part of
// the page chrome and has to apply to the LOGIN screen too, which is before any token exists. It exposes
// the same text Signum's HTML did to anyone who could load the app.
export namespace DynamicCSSOverrideLogic {

    export let cachedLazy: ResetLazy<DynamicCSSOverrideEntity[]>;

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(DynamicCSSOverrideEntity)
            .withSave(DynamicCSSOverrideOperation.Save)
            .withDelete(DynamicCSSOverrideOperation.Delete)
            .withQuery();

        // Signum filters `!a.Mixin<DisabledMixin>().IsDisabled` here; altea's flag is a plain field.
        cachedLazy = sb.globalLazy(
            () => table(DynamicCSSOverrideEntity).filter(a => !a.isDisabled).toArray() as Promise<DynamicCSSOverrideEntity[]>,
            { invalidateWith: [DynamicCSSOverrideEntity] });

        if (sb.webBuilder)
            startServer(sb.webBuilder);
    }

    /** The concatenated stylesheet, in Signum's order (`String.Join("\n", …Select(a => a.Script))`). */
    export async function getStyleSheet(): Promise<string> {
        const all = await cachedLazy.value();
        return all.map(a => a.script).join("\n");
    }

    function startServer(ws: WebBuilder): void {
        ws.get("/api/dynamic/cssOverrides",
            { res: CustomType<string>(), allowAnonymous: true },
            async (_req, res) => {
                res.jsonTyped(await getStyleSheet());
            });
    }
}
