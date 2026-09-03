import { WebBuilder, CustomType } from "./webApi";
import { VisualTipLogic } from "./visualTipLogic";

// Port of Signum's Basics/VisualTipController.cs — the two calls the "?" icon makes.
//
// Mounted by SignumServer, where Signum's controller lives: the SearchControl carries four visual tips, so
// this is framework surface rather than an extension's.
//
// altea divergences:
//  - the consume POST takes an OBJECT (`{ symbolKey }`), where Signum posts a bare JSON string. altea's
//    typed route wrapper describes a body by its shape, and a naked string is the one shape it cannot
//    name; wrapping it also leaves room for a second field without breaking the route.
//  - both routes are AUTHENTICATED (the default). They are per-user bookkeeping, so an anonymous caller
//    has nothing to read and nowhere to write — `getConsumed` answers an empty list rather than failing,
//    because the login screen renders SearchControls too.
export namespace VisualTipServer {
    export function start(ws: WebBuilder): void {

        ws.get("/api/visualtip/getConsumed",
            { res: CustomType<string[] | null>() },
            async (_req, res) => {
                res.jsonTyped(await VisualTipLogic.getConsumed());
            });

        ws.post("/api/visualtip/consume",
            { req: CustomType<{ symbolKey: string }>(), res: CustomType<null>() },
            async (req, res) => {
                const { symbolKey } = await req.jsonTyped();
                await VisualTipLogic.consume(symbolKey);
                res.jsonTyped(null);
            });
    }
}
