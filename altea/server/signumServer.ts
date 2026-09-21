import { WebBuilder } from "./webApi";
import { EntitiesServer } from "./entitiesServer";
import { QueryServer } from "./queryServer";
import { OperationServer } from "./operationServer";
import { ReflectionServer } from "./reflectionServer";
import { useExceptionFilter } from "./filters/exceptionFilter";
import { ExceptionLogic } from "./exceptionLogic";
import { ClientErrorModel } from "../data/clientError";
import { VisualTipServer } from "./visualTipServer";
import { ChangeLogServer } from "./changeLogServer";

// Port of Signum's SignumServer.Start (Signum/API/SignumServer.cs): mount the framework HTTP API on a
// WebBuilder. The host (an app's web bootstrap) creates the WebBuilder (createWebServer), calls this
// once, then serves the client + listens. Registration order mirrors Signum: the entity + query APIs
// first, the JSON error funnel last (it is Express error middleware, so it must come after the routes).
export namespace SignumServer {
    export function start(ws: WebBuilder): void {
        // FIRST: whatever a module deferred because it had to start before the filter chain was complete
        // (see WebBuilder.deferRoutes). Here, because this call is already last of the starter — after
        // every module, and before the exception middleware below, which must stay last of all.
        ws.mountDeferredRoutes();

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
        // Signum's SignumExceptionFilterAttribute: log + return an HttpError. Express error middleware,
        // so it MUST be registered last (after every route).
        useExceptionFilter(ws);
    }
}
