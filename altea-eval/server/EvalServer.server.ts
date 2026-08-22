import "@altea/altea/server";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { exploreModifiables, fullIntegrityCheckAsync } from "@altea/altea/server/graphExplorer";
import { Connector } from "@altea/altea/server/connection/connector";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { Entity, type Type } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { EvalPanelPermission } from "../data/EvalPanelPermission";
import { EvalLogic } from "./EvalLogic.server";

// Port of Signum.Eval's EvalPanelController.cs — "which stored scripts no longer compile?".
//
// altea divergences:
//  - Signum takes a `QueryEntitiesRequest` per registered FindOptions and the CLIENT loops; altea's registry
//    is a list of server-side loaders (see EvalLogic.evalSources), so ONE call checks everything and the
//    response says which source each failure came from.
//  - Signum calls `GraphExplorer.PreSaving(…)` then `FullIntegrityCheck()`. altea does the same two steps
//    explicitly — the preSaving events are what BIND an eval to its owner (`withEvals`), without which
//    `compile()` could not read the owner's fields.

/** Signum's EvalEntityError, plus which registered source the row came from. */
export interface EvalEntityError {
    source: string;
    lite: Lite<Entity>;
    error: string;
}

export namespace EvalServer {

    export function start(ws: WebBuilder): void {

        ws.post("/api/eval/evalErrors",
            { res: CustomType<EvalEntityError[]>() },
            async (_req, res) => {
                await assertAuthorized();
                res.jsonTyped(await getEvalErrors());
            });
    }

    export async function getEvalErrors(): Promise<EvalEntityError[]> {
        const schema = Connector.current().schema;
        const result: EvalEntityError[] = [];

        for (const source of EvalLogic.evalSources) {
            let entities: Entity[];
            try {
                entities = await source.load();
            }
            catch (e) {
                result.push({
                    source: source.name,
                    lite: null!,
                    error: e instanceof Error ? e.message : String(e),
                });
                continue;
            }

            for (const entity of entities) {
                // Signum's `GraphExplorer.PreSaving(() => GraphExplorer.FromRoot(entity))` — here it is also
                // what binds each eval to its owner, so the integrity check below can compile.
                const all = exploreModifiables([entity]);
                for (const m of all)
                    if (m instanceof Entity)
                        schema.entityEvents(m.constructor as Type<Entity>).onPreSaving(m);

                const checks = await fullIntegrityCheckAsync(all, "Saving");
                const error = checks
                    .flatMap(c => Object.values(c.errors))
                    .join("\n");

                if (error !== "")
                    result.push({ source: source.name, lite: entity.toLite(), error });
            }
        }

        return result;
    }

    async function assertAuthorized(): Promise<void> {
        if (!await PermissionAuthLogic.isAuthorized(EvalPanelPermission.ViewDynamicPanel))
            throw new UnauthorizedAccessException(
                `Not authorized to ${EvalPanelPermission.ViewDynamicPanel.key}`);
    }
}
