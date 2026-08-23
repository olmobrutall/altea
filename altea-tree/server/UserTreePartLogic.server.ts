import "@altea/altea/server";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { DashboardLogic } from "@altea/altea-dashboard/server/DashboardLogic.server";
import { UserQueryEntity } from "@altea/altea-user-queries/data/UserQuery";
import { UserTreePartEntity } from "../data/Tree";

// Port of Signum.Tree's UserTreePartLogic.cs — the dashboard part: a panel showing a tree, scoped by a
// stored user query.
//
// altea divergences: `DashboardLogic.PartNames.AddRange(...)` becomes ONE `registerPart` call that also
// carries the part's Clone / ToXml / FromXml (Signum declares those on the entity, which altea's data layer
// cannot — its entities are isomorphic and XML is a server concern); and
// `OnGetCachedQueryDefinition.Register(... => empty)` has no counterpart, because CachedQuery is not
// ported (see CLAUDE.md on altea-dashboard).
const A = "@_";

export namespace UserTreePartLogic {

    let started = false;

    export function start(sb: SchemaBuilder): void {
        if (started)
            return;
        started = true;

        sb.include(UserTreePartEntity).withQuery();

        DashboardLogic.registerPart<UserTreePartEntity>({
            type: UserTreePartEntity,
            elementName: "UserTreePart",
            clone: p => UserTreePartEntity.create({ userQuery: p.userQuery }),
            toXml: (p, ctx) => ({ [A + "UserQuery"]: ctx.include(p.userQuery) }),
            fromXml: (p, x, ctx) => {
                p.userQuery = ctx.getEntity(String(x[A + "UserQuery"])) as UserQueryEntity;
            },
        });
    }
}
