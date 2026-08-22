import "@altea/altea/server";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import * as Database from "@altea/altea/server/Database";
import { SystemTime } from "@altea/altea/server/systemTime";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Entity } from "@altea/altea/data/entity";
import { Temporal } from "@altea/altea/data/basics";
import { ObjectDumper } from "@altea/altea/data/objectDumper";

// Port of Signum.TimeMachine's TimeMachineController.cs (+ TimeMachineServer.cs) — the ONE route the
// Time Machine page calls: "give me this row as it was at that instant, plus its dump".
//
// The entity half feeds the "UI differences" tab (rendered through RenderEntity with the previous
// version on the TypeContext, which is what lights up core's `getTimeMachineIcon`); the dump half feeds
// the "Data differences" tab, diffed against the other version by altea-diff-log's DiffDocument — the
// same dump format the operation log stores, which is exactly why the two are comparable.
//
// altea divergences:
//  - the route is `/api/timeMachine/retrieveVersion/…` where Signum's is the unprefixed
//    `api/retrieveVersion/…`: every altea module namespaces its routes under its own segment.
//  - `Schema.ForceCultureInfo` is not needed — altea's ObjectDumper formats invariantly by construction
//    (Temporal → ISO, Decimal → toString), the same reason altea-diff-log gives.
//  - `ReflectionServer.RegisterLike(typeof(TimeMachineMessage), …)` has no counterpart: altea ships ONE
//    metadata blob and a message container is included by being registered, with no per-container
//    visibility predicate to attach.
//  - the read runs under `ExecutionMode.global`. Retrieving a HISTORY row goes through the ordinary
//    retrieve path, whose type-READ gate would otherwise re-check rules the quick link already checked;
//    and a history row may reference rows the current user cannot read today. The page itself is gated
//    by `TimeMachinePermission.ShowTimeMachine`.
export namespace TimeMachineServer {

    /** Signum's `EntityDump`: one version of a row, plus the ObjectDumper text of it. */
    export interface EntityDump {
        entity: Entity;
        dump: string;
    }

    export function start(ws: WebBuilder): void {

        ws.get("/api/timeMachine/retrieveVersion/:type/:id",
            { params: CustomType<{ type: string; id: string }>(), res: CustomType<EntityDump>() },
            async (req, res) => {
                const { type: typeName, id } = (req as unknown as { params: { type: string; id: string } }).params;
                const asOf = (req.query["asOf"] as string | undefined) ?? "";

                const type = Entity.resolveType(typeName);

                const entity = await ExecutionMode.global(() =>
                    SystemTime.override(new SystemTime.AsOf(parseAsOf(asOf)), () =>
                        Database.retrieve(type, type.parseId(id))));

                return res.jsonTyped({ entity, dump: ObjectDumper.dump(entity) } satisfies EntityDump);
            });
    }
}

// The client sends back the `SystemValidFrom` column value it read out of the search result, which
// altea materialises as a tz-naive PlainDateTime (see server/systemTime.ts on SystemTimeBound). Accept
// an instant too, so a caller that has a real UTC stamp is not forced to strip the zone first.
export function parseAsOf(asOf: string): Temporal.PlainDateTime | Temporal.Instant {
    if (asOf === "")
        throw new Error("The 'asOf' query parameter is required");
    return /[Zz]$|[+-]\d\d:?\d\d$/.test(asOf)
        ? Temporal.Instant.from(asOf)
        : Temporal.PlainDateTime.from(asOf);
}
