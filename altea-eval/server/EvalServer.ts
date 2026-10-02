import "@altea/altea/server";
import { PermissionLogic } from "@altea/altea/server/permissionLogic";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { exploreModifiables, fullIntegrityCheckAsync } from "@altea/altea/server/graphExplorer";
import { bindParentsOwn } from "@altea/altea/data/parentEntity";
import { Connector } from "@altea/altea/server/connection/connector";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { EvalPanelPermission } from "../data/EvalPanelPermission";
import { EvalLogic } from "./EvalLogic";
import { EvalCompiler } from "./EvalCompiler";
import { EvalEmbedded } from "../data/Eval";

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

        // ---- What the EDITOR needs ------------------------------------------------------------------------
        //
        // The editor checks the script against the SAME declarations the server compiles it against. There
        // is no second source of truth: both come out of the configuration, and the eager half is shipped
        // up front (half a megabyte — see EvalCompiler.declarationsFor) while the lazy half is fetched one
        // module at a time, when a script turns out to name something in it.
        //
        // Authenticated, and no further permission. These are the TYPE declarations of the application's own
        // code, and anyone who can open an eval editor is already being shown the signature they describe;
        // gating them behind the eval PANEL permission would blind the editor for exactly the people who
        // author workflow conditions. Nothing here reads data.

        ws.post("/api/eval/intelliSense",
            { res: CustomType<IntelliSenseResponse>() },
            async (_req, res) => {
                const configuration = EvalCompiler.clientConfiguration(EvalEmbedded.defaultImports);
                res.jsonTyped({
                    ...configuration,
                    root: EvalCompiler.CLIENT_ROOT,
                    declarations: EvalCompiler.declarationsFor(EvalEmbedded.defaultImports,
                        eagerSpecifiers(configuration.eagerLines)),
                });
            });

        ws.post("/api/eval/declarations",
            { req: CustomType<DeclarationsRequest>(), res: CustomType<EvalCompiler.DeclarationFile[]>() },
            async (req, res) => {
                const request = (await req.jsonTyped()) as DeclarationsRequest | undefined;
                res.jsonTyped(EvalCompiler.declarationsFor(EvalEmbedded.defaultImports,
                    request?.specifiers ?? [], new Set(request?.have ?? [])));
            });
    }

    /** What the editor is handed before it can check anything. */
    export interface IntelliSenseResponse extends EvalCompiler.ClientConfiguration {
        /** The directory the editor must pretend the script lives in, so relative imports resolve. */
        root: string;
        declarations: EvalCompiler.DeclarationFile[];
    }

    export interface DeclarationsRequest {
        specifiers: string[];
        /** Declaration paths the editor already holds, so a second module costs only what it adds. */
        have: string[];
    }

    /** The specifiers of the eager import lines — which is what their declarations have to be built from. */
    function eagerSpecifiers(eagerLines: readonly string[]): string[] {
        return eagerLines
            .map(line => /from\s+"([^"]+)"/.exec(line)?.[1])
            .filter((s): s is string => s != null);
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
                // What `saver` does before it checks anything, in the same order: BIND every modifiable,
                // then run the pre-saving pass. Binding is what gives an eval its owner, and so the main
                // entity type its generated signature names — an unbound eval skips validation entirely,
                // which would make this whole endpoint answer "no errors" however broken the scripts are.
                const all = exploreModifiables([entity]);
                for (const m of all)
                    bindParentsOwn(m);
                for (const m of all)
                    if (m instanceof Entity)
                        await schema.entityEvents(m.getType()).onPreSaving(m);

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
