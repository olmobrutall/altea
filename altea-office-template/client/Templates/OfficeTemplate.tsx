import * as React from "react";
import { Tabs, Tab } from "react-bootstrap";
import { EntityDetail } from "@altea/altea/client/Lines/EntityDetail";
import { resolveType } from "@altea/altea/data/registration";
import { TemplateApplicableEval } from "@altea/altea-templating/data/Templating";
import { EvalLine } from "@altea/altea-eval/client/EvalLine";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityCombo } from "@altea/altea/client/Lines/EntityCombo";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { FileLine } from "@altea/altea-files/client/Components/FileLine";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import { SubTokensOptions } from "@altea/altea/client/QueryToken";
import { tryGetTypeInfo } from "@altea/altea/client/Reflection";
import TemplateControls from "@altea/altea-templating/client/TemplateControls";
import QueryTokenEmbeddedBuilder from "@altea/altea-user-assets/client/Templates/QueryTokenEmbeddedBuilder";
import FilterBuilderEmbedded from "@altea/altea-user-queries/client/Templates/FilterBuilderEmbedded";
import { UserQueryEntity } from "@altea/altea-user-queries/data/UserQuery";
import { UserChartEntity } from "@altea/altea-chart/data/UserChart";
import { OfficeTemplateEntity, OfficeTemplateMessage } from "../../data/OfficeTemplate";

// Port of Signum.Word's Templates/WordTemplate.tsx — the template editor: the document, the query
// (filters / orders), applicability, and the two "embedded widget" helpers.
//
// altea divergences, documented inline:
//  - The APPLICABLE tab keeps Signum's shape — a stored SCRIPT in its own tab — through @altea/altea-eval's
//    EvalLine; the editor is TypeScript rather than C#, and the TypeHelp tree beside it is not ported. Same call
//    @altea/altea-email's EmailTemplate editor made.
//  - `EntityCombo(f => f.culture)` becomes a plain AutoLine: altea has no CultureInfoEntity, the culture is
//    a locale string (see the entity's header).
//  - `QueryDescription` is gone, so the widget buttons filter UserChart / UserQuery by the template's own
//    query key rather than by the entity implementations of the query's Entity column.
//  - Signum keys the widget code by the asset's `Guid` column; altea's user assets use a uuid PRIMARY KEY
//    as their portable identity, so it is `.id` (which is what the server-side providers match on).

export default function OfficeTemplate(p: { ctx: TypeContext<OfficeTemplateEntity> }): React.JSX.Element {

    const forceUpdate = useForceUpdate();

    const ctx = p.ctx;
    const ctx4 = ctx.subCtx({ labelColumns: 4 });
    const canAggregate = ctx.value.groupResults ? SubTokensOptions.CanAggregate : 0;
    const queryKey = ctx.value.query?.key;

    return (
        <div>
            <div className="row">
                <div className="col-sm-6">
                    <AutoLine ctx={ctx4.subCtx(f => f.name)} />
                    <EntityLine ctx={ctx4.subCtx(f => f.query)} onChange={forceUpdate} />
                    <EntityCombo ctx={ctx4.subCtx(f => f.model)} />
                </div>
                <div className="col-sm-6">
                    <EntityCombo ctx={ctx4.subCtx(f => f.officeTransformer)} />
                    <EntityCombo ctx={ctx4.subCtx(f => f.officeConverter)} />
                    <AutoLine ctx={ctx4.subCtx(f => f.culture)} />
                    <CheckboxLine ctx={ctx4.subCtx(f => f.disableAuthorization)} inlineCheckbox />
                </div>
            </div>

            <Tabs id={ctx.prefix + "tabs"} mountOnEnter={true}>
                <Tab eventKey="template" title={ctx.niceName(a => a.template)}>
                    <AutoLine ctx={ctx.subCtx(f => f.fileName)} />

                    <div className="card form-xs" style={{ marginTop: "10px", marginBottom: "10px" }}>
                        <div className="card-header" style={{ padding: "5px" }}>
                            <TemplateControls
                                queryKey={queryKey}
                                forHtml={false}
                                widgetButtons={
                                    <div className="btn-group" style={{ marginLeft: "auto" }}>
                                        {tryGetTypeInfo(UserChartEntity) != null && queryKey != null &&
                                            <UserChartTemplateButton queryKey={queryKey} />}
                                        {tryGetTypeInfo(UserQueryEntity) != null && queryKey != null &&
                                            <UserQueryTemplateButton queryKey={queryKey} />}
                                    </div>} />
                        </div>
                    </div>

                    <FileLine ctx={ctx.subCtx(e => e.template)} />
                </Tab>

                {ctx.value.query != null &&
                    <Tab eventKey="query"
                        title={
                            <span style={{ fontWeight: ctx.value.groupResults || ctx.value.filters.length > 0 || ctx.value.orders.length > 0 ? "bold" : undefined }}>
                                {ctx.niceName(a => a.query)}
                            </span>}>

                        <CheckboxLine ctx={ctx.subCtx(e => e.groupResults)} inlineCheckbox onChange={forceUpdate} />

                        <FilterBuilderEmbedded ctx={ctx.subCtx(e => e.filters)} onChanged={forceUpdate}
                            subTokenOptions={SubTokensOptions.CanAnyAll | SubTokensOptions.CanElement | SubTokensOptions.CanNested | canAggregate}
                            queryKey={ctx.value.query.key} />

                        <EntityTable ctx={ctx.subCtx(e => e.orders)} onChange={forceUpdate} columns={[
                            {
                                property: "token",
                                template: octx => <QueryTokenEmbeddedBuilder
                                    ctx={octx.subCtx(a => a.token, { formGroupStyle: "SrOnly" })}
                                    queryKey={ctx.value.query!.key}
                                    subTokenOptions={SubTokensOptions.CanElement | SubTokensOptions.CanNested | canAggregate} />,
                            },
                            { property: "orderType" },
                        ]} />
                    </Tab>}
                <Tab eventKey="applicable" title={ctx.niceName(a => a.applicable)}>
                    <EntityDetail ctx={ctx4.subCtx(f => f.applicable)} onChange={forceUpdate}
                        onCreate={() => Promise.resolve(TemplateApplicableEval.create({ script: "" }))}
                        getComponent={actx => <EvalLine ctx={actx} signature={applicableSignature(ctx.value)} />} />
                </Tab>
            </Tabs>
        </div>
    );
}

/**
 * Signum's UserChartTemplateButton — hands the author the alternative-text code that binds a chart in the
 * document to a stored UserChart (see TableBinder's header for how that addressing works).
 *
 * The `Pivot(0, 1, 2)` line is appended for a multi-series / stacked script whose split column is set,
 * because such a chart needs the flat result reshaped into a matrix before its series can be bound.
 */
export function UserChartTemplateButton(p: { queryKey: string }): React.JSX.Element {
    return renderWidgetButton(
        <><FontAwesomeIcon aria-hidden={true} icon="chart-bar" color="darkviolet" className="icon" /> {UserChartEntity.niceName()}</>,
        async () => {
            const uc = await Finder.find(UserChartEntity.findOptions(token => ({
                filterOptions: [{ token: token(a => a.query!.key), value: p.queryKey }],
            })));
            if (uc == null)
                return undefined;

            const uce = await Navigator.API.fetch(uc);
            let text = "UserChart:" + uce.id;

            const scriptKey = uce.chartScript.key;
            if ((scriptKey.includes("Multi") || scriptKey.includes("Stacked")) && uce.columns[1]?.element.token != null)
                text += "\nPivot(0, 1, 2)";

            return text;
        });
}

/** Signum's UserQueryTemplateButton — the same, for a table bound to a stored UserQuery. */
export function UserQueryTemplateButton(p: { queryKey: string }): React.JSX.Element {
    return renderWidgetButton(
        <><FontAwesomeIcon aria-hidden={true} icon="rectangle-list" color="dodgerblue" className="icon" /> {UserQueryEntity.niceName()}</>,
        async () => {
            const uq = await Finder.find(UserQueryEntity.findOptions(token => ({
                filterOptions: [{ token: token(a => a.query!.key), value: p.queryKey }],
            })));
            return uq == null ? undefined : "UserQuery:" + uq.id;
        });
}

/**
 * Signum shows the generated code in an AutoLineModal wrapping a TextAreaLine, which the author copies out.
 * altea has no AutoLineModal, so the code is shown in a MessageModal — selectable, with the instruction
 * above it. The author still copies it into the shape's alternative text; only the chrome differs.
 */
function renderWidgetButton(text: React.ReactElement, getCode: () => Promise<string | undefined>): React.JSX.Element {
    return (
        <button className="btn btn-tertiary btn-sm sf-button" type="button"
            onClick={() => void getCode().then(async code => {
                if (code == null)
                    return;

                await MessageModal.show({
                    buttons: "ok",
                    icon: "info",
                    style: "info",
                    title: OfficeTemplateMessage.SelectTheSourceOfDataForYourTableOrChart.niceToString(),
                    message: (
                        <div>
                            <p>{OfficeTemplateMessage.WriteThisKeyAsTileInTheAlternativeTextOfYourTableOrChart.niceToString()}</p>
                            <pre className="user-select-all">{code}</pre>
                        </div>
                    ),
                });
            })}>
            {text}
        </button>
    );
}

/** The signature the server generates for this template's applicable eval (see TemplateApplicableEval). */
function applicableSignature(template: OfficeTemplateEntity): string {
    const ctor = template.query == null ? undefined : resolveType(template.query.key);
    return `function evaluate(e: ${ctor?.name ?? "Entity"} | null): boolean`;
}
