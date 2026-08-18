import * as React from "react";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import SearchValueLine from "@altea/altea/client/SearchControl/SearchValueLine";
import { TypeContext, mlistItemContext } from "@altea/altea/client/TypeContext";
import { useAPI } from "@altea/altea/client/Hooks";
import { getQueryNiceName } from "@altea/altea/client/Reflection";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { DashboardEntity_Parts } from "@altea/altea-dashboard/data/Dashboard";
import type { PanelPartContentProps } from "@altea/altea-dashboard/client/DashboardClient";
import type { DashboardController } from "@altea/altea-dashboard/client/View/DashboardFilterController";
import { UserQueriesClient } from "../../UserQueriesClient";
import { ValueUserQueryListPartEntity_UserQueries, ValueUserQueryListPartEntity } from "../../../data/DashboardParts";

// Port of Signum's Signum.UserQueries/Dashboard/View/ValueUserQueryListPart.tsx — one "label → value" row per
// saved query. altea divergence: no cached-query custom request (CachedQuery is deferred), and a part row is
// a plain @part entity (Signum's `mle.element`).

export default function ValueUserQueryListPart(p: PanelPartContentProps<ValueUserQueryListPartEntity>): React.JSX.Element {
    const ctx = TypeContext.root(p.content, { formGroupStyle: "None" });
    return (
        <div>
            {
                mlistItemContext(ctx.subCtx(a => a.userQueries))
                    .map((ectx, i) =>
                        <div key={i}>
                            <ValueUserQueryElement ctx={ectx} entity={p.entity} dashboardController={p.dashboardController}
                                partEmbedded={p.partEmbedded} />
                        </div>)
            }
        </div>
    );
}

export interface ValueUserQueryElementProps {
    ctx: TypeContext<ValueUserQueryListPartEntity_UserQueries>;
    entity?: Lite<Entity>;
    dashboardController: DashboardController;
    partEmbedded: DashboardEntity_Parts;
}

export function ValueUserQueryElement(p: ValueUserQueryElementProps): React.JSX.Element {

    const fo = useAPI(() => UserQueriesClient.Converter.toFindOptions(p.ctx.value.userQuery, p.entity),
        [p.ctx.value.userQuery, p.entity?.key()]);

    const ctx = p.ctx;
    const ctx2 = ctx.subCtx({ formGroupStyle: "SrOnly" });

    if (!fo)
        return <span>{JavascriptMessage.loading.niceToString()}</span>;

    const foExpanded = p.dashboardController.applyToFindOptions(p.partEmbedded, fo);

    return (
        <div>
            <FormGroup ctx={ctx} label={ctx.value.label ?? getQueryNiceName(foExpanded.queryName)}>
                {() =>
                    <div className="row align-items-center">
                        <div className="col-auto">
                            <span>{ctx.value.label ?? getQueryNiceName(foExpanded.queryName)}</span>
                        </div>
                        <div className="col-auto">
                            <SearchValueLine ctx={ctx2} findOptions={foExpanded} />
                        </div>
                    </div>}
            </FormGroup>
        </div>
    );
}
