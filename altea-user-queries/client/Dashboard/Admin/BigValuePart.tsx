import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { EnumLine } from "@altea/altea/client/Lines/EnumLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { SubTokensOptions } from "@altea/altea/client/QueryToken";
import QueryTokenEmbeddedBuilder from "@altea/altea-user-assets/client/Templates/QueryTokenEmbeddedBuilder";
import { getEntityTypeHelpText, type PartEditorProps } from "@altea/altea-dashboard/client/Admin/PartEditor";
import { UserQueryEntity } from "../../../data/UserQuery";
import { BigValuePartEntity } from "../../../data/DashboardParts";
import { BigValueClient } from "../../BigValueClient";

// Port of Signum's Signum.UserQueries/Dashboard/Admin/BigValuePart.tsx. altea divergences: the owning
// dashboard arrives as a PROP (no findParentCtx), and the value token is built against the user query's
// query key — or, with no user query, against the dashboard's own entity type.

export default function BigValuePart(p: PartEditorProps<BigValuePartEntity>): React.JSX.Element {
    const ctx = p.ctx.subCtx({ formGroupStyle: "Basic" });
    const forceUpdate = useForceUpdate();
    const dashboardEntityType = p.dashboard?.entityType;
    const entityTypeName = dashboardEntityType?.toString();

    return (
        <div>
            <EntityLine ctx={ctx.subCtx(bv => bv.userQuery)} mandatory={entityTypeName ? "warning" : true} create={false}
                findOptions={dashboardEntityType ? UserQueryEntity.findOptions(token => ({
                    filterOptions: [token(a => a.entityType).filter("EqualTo", dashboardEntityType, { pinned: { active: "Checkbox_Checked" } })],
                })) : undefined}
                helpText={getEntityTypeHelpText(entityTypeName, ctx.value.userQuery?.entityType?.toString())}
                onChange={() => {
                    ctx.value.valueToken = null;
                    forceUpdate();
                }} />
            {
                ctx.value.userQuery ?
                    <QueryTokenEmbeddedBuilder ctx={ctx.subCtx(bv => bv.valueToken)} queryKey={ctx.value.userQuery.query.key}
                        subTokenOptions={SubTokensOptions.CanElement | SubTokensOptions.CanAggregate} /> :
                    entityTypeName ?
                        <QueryTokenEmbeddedBuilder ctx={ctx.subCtx(bv => bv.valueToken)} queryKey={entityTypeName}
                            subTokenOptions={0 as SubTokensOptions} /> :
                        null
            }
            <EnumLine ctx={ctx.subCtx(bv => bv.customBigValue)}
                optionItems={BigValueClient.getKeys(entityTypeName)}
                lineType="ComboBoxText" />
            <CheckboxLine ctx={ctx.subCtx(bv => bv.navigate)} onChange={forceUpdate} inlineCheckbox="block" />
            {ctx.value.navigate && <AutoLine ctx={ctx.subCtx(bv => bv.customUrl)} />}
            <CheckboxLine ctx={ctx.subCtx(bv => bv.isClickable)} inlineCheckbox="block" />
        </div>
    );
}
