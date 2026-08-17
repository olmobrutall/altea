import { Enum } from "@altea/altea/data/enum";
import { type int } from "@altea/altea/data/basics";
import { QueryTokenEmbedded } from "@altea/altea-user-assets/data/Queries";
import { DashboardLogic } from "@altea/altea-dashboard/server/DashboardLogic.server";
import {
    AutoUpdateEnum, BigValuePartEntity, UserQueryPartEntity, ValueUserQueryElementEmbedded,
    ValueUserQueryListPartEntity,
} from "../data/DashboardParts";
import { UserQueryEntity } from "../data/UserQuery";

// Port of the ToXml / FromXml / Clone members Signum declares ON the UserQuery dashboard part entities
// (Signum.UserQueries/UserQueryEntity.cs), plus the `PartNames` entries its UserQueryLogic.Start registered
// inside `sb.Schema.WhenIncluded<DashboardEntity>`. altea keeps XML off the isomorphic entities, so each part
// registers here with @altea/altea-dashboard's part registry (element names preserved for round-trip
// compatibility with Signum-exported dashboards).
//
// altea divergence: the `IsQueryCached` attributes are neither written nor read (CachedQuery is deferred).

const A = "@_";

export function registerUserQueryDashboardParts(): void {

    DashboardLogic.registerPart<UserQueryPartEntity>({
        type: UserQueryPartEntity,
        elementName: "UserQueryPart",
        clone: p => {
            const c = new UserQueryPartEntity();
            c.userQuery = p.userQuery;
            c.autoUpdate = p.autoUpdate;
            c.allowSelection = p.allowSelection;
            c.showFooter = p.showFooter;
            c.createNew = p.createNew;
            c.allowMaxHeight = p.allowMaxHeight;
            return c;
        },
        toXml: (p, ctx) => {
            const x: Record<string, unknown> = { [A + "UserQuery"]: ctx.include(p.userQuery) };
            x[A + "AllowSelection"] = p.allowSelection;
            if (p.showFooter) x[A + "ShowFooter"] = true;
            if (p.createNew) x[A + "CreateNew"] = true;
            if (p.allowMaxHeight) x[A + "AllowMaxHeight"] = true;
            const autoUpdate = Enum.toName(AutoUpdateEnum, p.autoUpdate);
            if (autoUpdate !== "None") x[A + "AutoUpdate"] = autoUpdate;
            return x;
        },
        fromXml: (p, x, ctx) => {
            p.userQuery = ctx.getEntity(str(x[A + "UserQuery"])!) as UserQueryEntity;
            p.allowSelection = x[A + "AllowSelection"] == null ? true : bool(x[A + "AllowSelection"]);
            p.showFooter = bool(x[A + "ShowFooter"]);
            p.createNew = bool(x[A + "CreateNew"]);
            p.allowMaxHeight = bool(x[A + "AllowMaxHeight"]);
            p.autoUpdate = toEnum(AutoUpdateEnum, str(x[A + "AutoUpdate"]) ?? "None");
        },
    });

    DashboardLogic.registerPart<ValueUserQueryListPartEntity>({
        type: ValueUserQueryListPartEntity,
        elementName: "ValueUserQueryListPart",
        clone: p => {
            const c = new ValueUserQueryListPartEntity();
            c.userQueries = (p.userQueries ?? []).map(e => {
                const row = new ValueUserQueryElementEmbedded();
                row.label = e.label;
                row.userQuery = e.userQuery;
                row.href = e.href;
                row.order = e.order;
                return row;
            });
            return c;
        },
        toXml: (p, ctx) => ({
            ValueUserQueryElement: (p.userQueries ?? []).map(e => {
                const x: Record<string, unknown> = { [A + "UserQuery"]: ctx.include(e.userQuery) };
                if (e.label != null) x[A + "Label"] = e.label;
                if (e.href != null) x[A + "Href"] = e.href;
                return x;
            }),
        }),
        fromXml: (p, x, ctx) => {
            p.userQueries = list(x["ValueUserQueryElement"]).map((e, i) => {
                const row = new ValueUserQueryElementEmbedded();
                row.order = i as unknown as int;
                row.label = str(e[A + "Label"]) ?? null;
                row.href = str(e[A + "Href"]) ?? null;
                row.userQuery = ctx.getEntity(str(e[A + "UserQuery"])!) as UserQueryEntity;
                return row;
            });
        },
    });

    DashboardLogic.registerPart<BigValuePartEntity>({
        type: BigValuePartEntity,
        elementName: "BigValuePart",
        clone: p => {
            const c = new BigValuePartEntity();
            c.valueToken = p.valueToken;
            c.userQuery = p.userQuery;
            c.customBigValue = p.customBigValue;
            c.navigate = p.navigate;
            c.customUrl = p.customUrl;
            c.isClickable = p.isClickable;
            return c;
        },
        toXml: (p, ctx) => {
            const x: Record<string, unknown> = {};
            if (p.userQuery != null) x[A + "UserQuery"] = ctx.include(p.userQuery);
            if (p.valueToken != null) x[A + "ValueToken"] = p.valueToken.tokenString;
            if (p.customBigValue != null) x[A + "CustomBigValue"] = p.customBigValue;
            if (p.navigate) x[A + "Navigate"] = true;
            if (p.customUrl != null) x[A + "CustomUrl"] = p.customUrl;
            if (p.isClickable != null) x[A + "IsClickable"] = p.isClickable;
            return x;
        },
        fromXml: (p, x, ctx) => {
            const uq = str(x[A + "UserQuery"]);
            p.userQuery = uq == null ? null : ctx.getEntity(uq) as UserQueryEntity;
            const valueToken = str(x[A + "ValueToken"]);
            p.valueToken = valueToken == null ? null : token(valueToken);
            p.customBigValue = str(x[A + "CustomBigValue"]) ?? null;
            p.navigate = bool(x[A + "Navigate"]);
            p.customUrl = str(x[A + "CustomUrl"]) ?? null;
            p.isClickable = x[A + "IsClickable"] == null ? null : bool(x[A + "IsClickable"]);
        },
    });
}

// ---- small helpers (mirrors UserQueriesXml.server.ts) ---------------------------------------------------

function token(tokenString: string): QueryTokenEmbedded {
    const t = new QueryTokenEmbedded();
    t.tokenString = tokenString;
    return t;
}

function toEnum<E extends Record<string, string | number>>(e: E, name: string): number {
    return Enum.toValue(e, name as Extract<keyof E, string>);
}

function str(v: unknown): string | undefined {
    return v == null ? undefined : String(v);
}
function bool(v: unknown): boolean {
    return v === true || v === "true" || v === "True";
}
function list(v: unknown): Record<string, unknown>[] {
    return (Array.isArray(v) ? v : v != null ? [v] : []) as Record<string, unknown>[];
}
