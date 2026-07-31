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

import { Entity, type PrimaryKey, type Type } from "../entities/entity";
import { entityIntegrityCheck } from "../entities/validation";
import type { EntityPack } from "../entities/entityPack";
import * as Database from "./Database";
import { Saver } from "./saver";
import { table } from "./table";
import { Connector } from "./connection/connector";
import { getEntityPack } from "./operationServer";
import { WebBuilder, ArrayOf, Primitive, CustomType } from "./webApi";

// Coerce a route-param id (always a string off the URL) to the entity's primary-key runtime type
// (Signum's PrimaryKey.Parse(id, type)): numeric for int/long PKs, left as a string for uuid/string.
function parseId(type: Type<Entity>, rawId: PrimaryKey): PrimaryKey {
    const raw = String(rawId);
    const col = Connector.current().schema.table(type).primaryKey.column;
    // uuid/string PK → keep the string. Otherwise (int/long, incl. identity columns whose dbType
    // family may be inconclusive) coerce an integer-looking id to a number so it matches e.id.
    if (col.dbType.isGuid() || col.dbType.isString()) return raw;
    return /^-?\d+$/.test(raw) ? Number(raw) : raw;
}

export namespace EntitiesServer {

    export function start(ws: WebBuilder): void {

        ws.get("/api/entity/:type/:id",
            { params: CustomType<{ type: string; id: PrimaryKey }>(), res: Entity },
            async (req, res) => {
                const type = Entity.resolveType(req.params.type);
                const e = await Database.retrieve(type, parseId(type, req.params.id));
                return res.jsonTyped(e);
            });

        ws.get("/api/fetchAll/:type",
            { params: CustomType<{ type: string }>(), res: ArrayOf(Entity) },
            async (req, res) => {
                const all = await table(Entity.resolveType(req.params.type)).toArray();
                return res.jsonTyped(all);
            });

        ws.get("/api/exists/:type/:id",
            { params: CustomType<{ type: string; id: PrimaryKey }>(), res: Primitive("bool") },
            async (req, res) => {
                let exists = true;
                const type = Entity.resolveType(req.params.type);
                try { await Database.retrieve(type, parseId(type, req.params.id)); }
                catch { exists = false; }
                return res.jsonTyped(exists);
            });

        ws.get("/api/entityPack/:type/:id",
            { params: CustomType<{ type: string; id: PrimaryKey }>(), res: CustomType<EntityPack<Entity>>() },
            async (req, res) => {
                const type = Entity.resolveType(req.params.type);
                const e = await Database.retrieve(type, parseId(type, req.params.id));
                return res.jsonTyped(getEntityPack(e));
            });

        ws.post("/api/entityPackEntity",
            { req: Entity, res: CustomType<EntityPack<Entity>>() },
            async (req, res) => {
                const entity = await req.jsonTyped();
                return res.jsonTyped(getEntityPack(entity));
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
