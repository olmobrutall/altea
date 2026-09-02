import * as React from "react";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EnumLine } from "@altea/altea/client/Lines/EnumLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useAPI, useForceUpdate } from "@altea/altea/client/Hooks";
import { UserQueryEntity } from "@altea/altea-user-queries/data/UserQuery";
import { SendEmailTaskEntity, EmailTemplateTargetFrom } from "../../data/SendEmailTask";

// Port of Signum.Mailing/Package/SendEmailTask.tsx — the editor picks the template first, then narrows what
// a target can be: a template with NO query can only send to nothing, one WITH a query must send to a
// unique entity or to a user query over that same query.
//
// altea divergence: Signum reads the target type from
// `Finder.getQueryDescription(key).columns["Entity"].type.name`. There is no QueryDescription here — a
// token tree is built client-side from the reflection metadata — so the same answer comes off the query's
// ROOT TOKEN, which is what `getQueryRoot` returns.

export default function SendEmailTask(p: { ctx: TypeContext<SendEmailTaskEntity> }): React.JSX.Element {

    const forceUpdate = useForceUpdate();

    const target = useAPI(async () => {
        if (p.ctx.value.emailTemplate == null)
            return null;

        const template = await Navigator.API.fetch(p.ctx.value.emailTemplate);
        if (template.query == null)
            return { queryKey: null, type: null };

        const root = await Finder.getQueryRoot(template.query.key);
        return { queryKey: template.query.key, type: root.type.typeName };
    }, [p.ctx.value.emailTemplate]);

    // Keep targetFrom consistent with whether the template HAS a query — Signum's same effect.
    React.useEffect(() => {
        if (target === undefined)
            return;
        if (target?.type != null) {
            if (p.ctx.value.targetFrom === EmailTemplateTargetFrom.NoTarget) {
                p.ctx.value.targetFrom = EmailTemplateTargetFrom.Unique;
                forceUpdate();
            }
        } else if (p.ctx.value.targetFrom !== EmailTemplateTargetFrom.NoTarget) {
            p.ctx.value.targetFrom = EmailTemplateTargetFrom.NoTarget;
            forceUpdate();
        }
    }, [target]);

    const clearTargets = (): void => {
        p.ctx.value.targetsFromUserQuery = null;
        p.ctx.value.uniqueTarget = null;
        forceUpdate();
    };

    const sc = p.ctx.subCtx({ formGroupStyle: "Basic" });

    return (
        <div>
            <AutoLine ctx={sc.subCtx(s => s.name)} />
            <EntityLine ctx={sc.subCtx(s => s.emailTemplate)} onChange={clearTargets}
                helpText={target && ("Query: " + (target.queryKey ?? "null"))} />

            <div className="row">
                <div className="col-sm-6">
                    {sc.value.emailTemplate && <EnumLine ctx={sc.subCtx(s => s.targetFrom)} onChange={clearTargets}
                        optionItems={target?.type == null
                            ? [EmailTemplateTargetFrom.NoTarget]
                            : [EmailTemplateTargetFrom.Unique, EmailTemplateTargetFrom.UserQuery]} />}
                </div>
                <div className="col-sm-6">
                    {target?.type && sc.value.targetFrom === EmailTemplateTargetFrom.UserQuery &&
                        <EntityLine ctx={sc.subCtx(s => s.targetsFromUserQuery)}
                            findOptions={UserQueryEntity.findOptions(token => ({
                                filterOptions: [{ token: token(a => a.query.key), value: target.queryKey }],
                            }))} />}
                    {target?.type && sc.value.targetFrom === EmailTemplateTargetFrom.Unique &&
                        <EntityLine ctx={sc.subCtx(s => s.uniqueTarget)} />}
                </div>
            </div>
        </div>
    );
}
