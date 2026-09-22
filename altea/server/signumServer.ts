import { WebBuilder } from "./webApi";
import { EntitiesServer } from "./entitiesServer";
import { QueryServer } from "./queryServer";
import { OperationServer } from "./operationServer";
import { ReflectionServer } from "./reflectionServer";
import { ExceptionLogic } from "./exceptionLogic";
import { ClientErrorModel } from "../data/clientError";
import { VisualTipServer } from "./visualTipServer";
import { ChangeLogServer } from "./changeLogServer";

// Port of Signum's SignumServer.Start (Signum/API/SignumServer.cs): mount the framework HTTP API on a
// WebBuilder. The host (an app's web bootstrap) creates the WebBuilder (createWebServer), calls this
// once, then serves the client + listens.
//
// It may be called wherever Signum's Starter calls it — FIRST, before any module — because nothing about
// a route depends on when it was registered: the user scope is mounted by the WebBuilder itself, and the
// authorization and culture seams are read per request.
//
// The one piece that cannot live here is the JSON error funnel: `useExceptionFilter` is Express ERROR
// middleware, so it has to be registered after every route in the process, which only the host knows. It
// is the host's last act before listening (see an application's webServer). Signum has no counterpart
// because its SignumExceptionFilterAttribute is an MVC filter, added to the MVC options rather than to
// the terminal pipeline.
export namespace SignumServer {
    export function start(ws: WebBuilder): void {
        EntitiesServer.start(ws);
        QueryServer.start(ws);
        OperationServer.start(ws);
        ReflectionServer.start(ws);
        VisualTipServer.start(ws);
        ChangeLogServer.start(ws);

        // Signum's ExceptionController.RegisterClientError: the client's unhandled-error logger POSTs a
        // ClientErrorModel here; log it as a Frontend ExceptionEntity. 204 (fire-and-forget).
        ws.post("/api/registerClientError", { req: ClientErrorModel, allowAnonymous: true },
            async (req, res) => {
                const model = await req.jsonTyped() as ClientErrorModel;
                await ExceptionLogic.logClientError(model);
                res.status(204).end();
            });

        // TODO (Phase 2): per-type DB reflection (typeEntity/enumEntities), query description.
    }
}
