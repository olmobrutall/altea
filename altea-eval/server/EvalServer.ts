import "@altea/altea/server";
import { PermissionLogic } from "@altea/altea/server/permissionLogic";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { exploreModifiables, fullIntegrityCheckAsync } from "@altea/altea/server/graphExplorer";
import { Connector } from "@altea/altea/server/connection/connector";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { EvalPanelPermission } from "../data/EvalPanelPermission";
import { EvalLogic } from "./EvalLogic";

// "Which stored scripts no longer compile?" ONE call checks everything, because the registry is a list of
// server-side loaders (see EvalLogic.evalSources), and the response says which source each failure came
// from.
//
// Port of Signum.Eval's EvalPanelController.cs — see port/Eval.md.

/** One failing script: the entity, the error, and which registered source it came from. */
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
                // The pre-saving pass is also
                // what binds each eval to its owner, so the integrity check below can compile.
                const all = exploreModifiables([entity]);
                for (const m of all)
                    if (m instanceof Entity)
                        schema.entityEvents(m.getType()).onPreSaving(m);

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
        if (!await PermissionLogic.isAuthorized(EvalPanelPermission.ViewDynamicPanel))
            throw new UnauthorizedAccessException(
                `Not authorized to ${EvalPanelPermission.ViewDynamicPanel.key}`);
    }
}
