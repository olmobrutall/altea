import { WebBuilder } from "./webApi";
import { EntitiesServer } from "./entitiesServer";
import { QueryServer } from "./queryServer";
import { OperationServer } from "./operationServer";
import { ReflectionServer } from "./reflectionServer";

// Port of Signum's SignumServer.Start (Signum/API/SignumServer.cs): mount the framework HTTP API on a
// WebBuilder. The host (an app's web bootstrap) creates the WebBuilder (createWebServer), calls this
// once, then serves the client + listens. Registration order mirrors Signum: the entity + query APIs
// first, the JSON error funnel last (it is Express error middleware, so it must come after the routes).
export namespace SignumServer {
    export function start(ws: WebBuilder): void {
        EntitiesServer.start(ws);
        QueryServer.start(ws);
        OperationServer.start(ws);
        ReflectionServer.start(ws);
        // TODO (Phase 2): per-type DB reflection (typeEntity/enumEntities), query description.
        ws.useDefaultErrorHandler();
    }
}
