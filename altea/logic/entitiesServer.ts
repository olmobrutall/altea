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

import { Entity, type PrimaryKey } from "../entities/entity";
import { Serializer } from "../entities/serializer";
import { entityIntegrityCheck } from "../entities/validation";
import type { EntityPack } from "../entities/entityPack";
import * as Database from "./Database";
import { Saver } from "./saver";
import { table } from "./table";
import { WebBuilder, ArrayOf, Primitive, CustomType } from "./webApi";

export namespace EntitiesServer {

    export function start(ws: WebBuilder): void {

        ws.get("/api/entity/:type/:id",
            { params: CustomType<{ type: string; id: PrimaryKey }>(), res: Entity },
            async (req, res) => {
                const e = await Database.retrieve(Entity.resolveType(req.params.type), req.params.id);
                return res.jsonTyped(e);
            });

        ws.get("/api/fetchAll/:type",
            { params: CustomType<{ type: string }>(), res: ArrayOf(Entity) },
            async (req, res) => {
                const all = await table(Entity.resolveType(req.params.type) as new () => Entity).toArray();
                return res.jsonTyped(all);
            });

        ws.get("/api/exists/:type/:id",
            { params: CustomType<{ type: string; id: PrimaryKey }>(), res: Primitive("bool") },
            async (req, res) => {
                let exists = true;
                try { await Database.retrieve(Entity.resolveType(req.params.type), req.params.id); }
                catch { exists = false; }
                return res.jsonTyped(exists);
            });

        ws.get("/api/entityPack/:type/:id",
            { params: CustomType<{ type: string; id: PrimaryKey }>(), res: CustomType<EntityPack<Entity>>() },
            async (req, res) => {
                const e = await Database.retrieve(Entity.resolveType(req.params.type), req.params.id);
                // The entity is embedded as its serialized graph (the client re-parses it).
                return res.jsonTyped({ entity: JSON.parse(Serializer.stringify(e)) as Entity, canExecute: {} });
            });

        ws.post("/api/entityPackEntity",
            { req: Entity, res: CustomType<{ canExecute: {} }>() },
            async (req, res) => {
                // The client keeps its own entity; the server only supplies canExecute (TODO: OperationLogic).
                return res.jsonTyped({ canExecute: {} });
            });

        ws.post("/api/validateEntity",
            { req: Entity },
            async (req, res) => {
                const entity = await req.jsonTyped();
                const ic = entityIntegrityCheck(entity);
                if (ic) { res.modelState(ic); return; }
                res.status(200).end();
            });

        ws.post("/api/save",
            { req: Entity, res: Entity },
            async (req, res) => {
                const entity = await req.jsonTyped();
                const ic = entityIntegrityCheck(entity);
                if (ic) return res.modelState(ic);
                await Saver.save([entity]);
                return res.jsonTyped(entity); // Saver mutates the root with its new id / ticks
            });
    }
}
