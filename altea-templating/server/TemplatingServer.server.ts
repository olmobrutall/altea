import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { GlobalValueProvider } from "./ValueProviders.server";
import type { GlobalVariableTS } from "../data/Templating";

// Port of Signum.Templating's TemplatingController.cs + TemplatingServer.cs — the one call the template
// editor makes: "which `@[g:Key]` variables may I insert?".
//
// altea divergences:
//  - Signum's `ReflectionServer.RegisterLike(typeof(TemplateTokenMessage), …)` gated the message enum's
//    translations behind "may this role see email templates". altea ships ONE global reflection blob
//    (translations included) at boot, so there is no per-container gate to register; the callback list
//    (`TemplateTokenMessageAllowed`) goes with it.
//  - The response carries the type NAME + isCollection rather than Signum's TypeReferenceTS DTO: the
//    editor only needs to know whether a variable is insertable and whether it is a collection.

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
