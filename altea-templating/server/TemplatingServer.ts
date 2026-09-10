import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { GlobalValueProvider } from "./ValueProviders";
import type { GlobalVariableTS } from "../data/Templating";

// Port of Signum.Templating's TemplatingController.cs + TemplatingServer.cs — see docs/port/Templating.md.
//
// The one call the template editor makes: "which `@[g:Key]` variables may I insert?". The response carries
// the type NAME + isCollection, which is all the editor needs to know.

export namespace TemplatingServer {
    let started = false;

    export function start(ws: WebBuilder): void {
        if (started)
            return;
        started = true;

        ws.get("/api/templating/getGlobalVariables",
            { res: CustomType<GlobalVariableTS[]>() },
            async (_req, res) => {
                const result: GlobalVariableTS[] = [...GlobalValueProvider.globalVariables].map(([key, gv]) => ({
                    key,
                    typeName: gv.type.getTypeName() ?? gv.type.typeName,
                    isCollection: gv.type.array === true,
                }));
                res.jsonTyped(result);
            });
    }
}
