// The entity HTTP API (Signum's EntitiesController.cs), on altea's typed `ws` wrapper (../webApi) —
// the server half of react/Navigator.API. Register on a SchemaBuilder's webBuilder:
//   EntitiesServer.start(sb.webBuilder);
//
// Each route declares { params?, req?, res? }: `params` types req.params (so req.params.type is a
// real string and req.params.id a PrimaryKey), the body is deserialized+typed (req.jsonTyped) and
// the response serialized+typed (res.jsonTyped) via the Serializer (entities/serializer). Types are
// resolved + inheritance-checked via Entity.resolveType. altea has no "controller" — this is a
// *Server module started with the web builder.
//
// TODO: canExecute (OperationLogic), efficient exists, primary-key coercion, Serializer.parse
// `resolve` overlay onto the DB original.

import { Entity } from "../data/entity";
import { entityIntegrityCheck } from "../data/validation";
import type { EntityPack } from "../data/entityPack";
import * as Database from "./Database";
import { assertGraphIntegrity } from "./graphExplorer";
import { Saver } from "./saver";
import { table } from "./table";
import { getEntityPack } from "./operationServer";
import { WebBuilder, ArrayOf, Primitive, CustomType } from "./webApi";

export namespace EntitiesServer {

    export function start(ws: WebBuilder): void {

        ws.get("/api/entity/:type/:id",
            { params: CustomType<{ type: string; id: string }>(), res: Entity },
            async (req, res) => {
                const type = Entity.resolveType(req.params.type);
                const e = await Database.retrieve(type, type.parseId(req.params.id));
                return res.jsonTyped(e);
            });

        ws.get("/api/fetchAll/:type",
            { params: CustomType<{ type: string }>(), res: ArrayOf(Entity) },
            async (req, res) => {
                const all = await table(Entity.resolveType(req.params.type)).toArray();
                return res.jsonTyped(all);
            });

        ws.get("/api/exists/:type/:id",
            { params: CustomType<{ type: string; id: string }>(), res: Primitive("bool") },
            async (req, res) => {
                let exists = true;
                const type = Entity.resolveType(req.params.type);
                try { await Database.retrieve(type, type.parseId(req.params.id)); }
                catch { exists = false; }
                return res.jsonTyped(exists);
            });

        ws.get("/api/entityPack/:type/:id",
            { params: CustomType<{ type: string; id: string }>(), res: CustomType<EntityPack<Entity>>() },
            async (req, res) => {
                const type = Entity.resolveType(req.params.type);
                const e = await Database.retrieve(type, type.parseId(req.params.id));
                return res.jsonTyped(getEntityPack(e));
            });

        ws.post("/api/entityPackEntity",
            { req: Entity, res: CustomType<EntityPack<Entity>>() },
            async (req, res) => {
                const entity = await req.jsonTyped();
                return res.jsonTyped(getEntityPack(entity));
            });

        // The client's pre-flight "would this save?" check (FrameModal). Validate as the save would
        // (the "Saving" phase, strictest) and return a 400 ModelState if invalid, else 200.
        ws.post("/api/validateEntity",
            { req: Entity },
            async (req, res) => {
                const entity = await req.jsonTyped();
                const ic = entityIntegrityCheck(entity, "Saving");
                if (ic) { res.modelState(ic); return; }
                res.status(200).end();
            });

        ws.post("/api/save",
            { req: Entity, res: Entity },
            async (req, res) => {
                const entity = await req.jsonTyped();
                assertGraphIntegrity([entity], "ServerDeserialization"); // phase 2
                await Saver.save([entity]);                              // phase 3 ("Saving") runs inside
                return res.jsonTyped(entity); // Saver mutates the root with its new id / ticks
            });
    }
}
