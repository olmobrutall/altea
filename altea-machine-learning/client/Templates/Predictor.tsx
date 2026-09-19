import * as React from "react";
import { Tab, Tabs } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { TypeContext } from "@altea/altea/client/TypeContext";
import type { BaseEntity } from "@altea/altea/data/entity";
import type { ButtonBarElement, ButtonsContext, IRenderButtons } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityCombo } from "@altea/altea/client/Lines/EntityCombo";
import { EntityDetail } from "@altea/altea/client/Lines/EntityDetail";
import { EntityRepeater } from "@altea/altea/client/Lines/EntityRepeater";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { EntityTabRepeater } from "@altea/altea/client/Lines/EntityTabRepeater";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import { Finder } from "@altea/altea/client/Finder";
import { Navigator } from "@altea/altea/client/Navigator";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { useAPI, useForceUpdate, useInterval } from "@altea/altea/client/Hooks";
import { SubTokensOptions } from "@altea/altea/client/QueryToken";
import type { QueryToken } from "@altea/altea/client/QueryToken";
import type { ColumnOption, FindOptions } from "@altea/altea/client/FindOptions";
import { FileLine } from "@altea/altea-files/client/Components/FileLine";
import QueryTokenEmbeddedBuilder from "@altea/altea-user-assets/client/Templates/QueryTokenEmbeddedBuilder";
import { QueryTokenEmbedded } from "@altea/altea-user-assets/data/Queries";
import {
    FilterBuilderEmbedded, toFilterOptionParsed,
} from "@altea/altea-user-queries/client/Templates/FilterBuilderEmbedded";
import { NeuralNetworkSettingsEntity } from "../../data/NeuralNetworkSettings";
import {
    PredictorCodificationEntity, PredictorEntity, PredictorEpochProgressEntity, PredictorFileType,
    PredictorMessage, PredictorState, PredictorSubQueryColumnUsage, PredictorSubQueryEntity,
    PredictorSubQueryEntity_Column, type TrainingProgress,
} from "../../data/Predictor";
import { MachineLearningClient } from "../MachineLearningClient";
import { initializeColumn } from "./ColumnDefaults";
import { LossChart } from "./LossChart";
import {
    ClassificationMetricsPanel, MetricsPanel, RegressionMetricsPanel,
} from "./Metrics";
import PredictorSubQuery from "./PredictorSubQuery";

// Port of Signum.MachineLearning's Templates/Predictor.tsx — the predictor DESIGNER.
//
// The tab order is the workflow, and it is Signum's: define the population and the columns (Query), tune
// the network (Settings), then — only once it has run — inspect what the training made of it
// (Codifications / Progress / Results). Everything but the first tab is hidden in Draft, because there is
// nothing to show and offering it invites the belief that there is.
//
// The whole form goes READ-ONLY the moment the predictor leaves Draft. That is not a UI nicety: the
// codifications persist a slot assignment computed from these exact columns, so editing a column of a
// trained predictor would leave a model whose inputs no longer mean what it learned. Signum does the
// same, in the same place.
//
// altea divergences, documented inline:
//  - `ProgressBar` lives in Signum's framework; there is none here, so the training bar is
//    local (it is nine lines of Bootstrap markup).
//  - the loss chart is `LossChart` (inline SVG) rather than Signum's d3 `LineChart` — see that file.
//  - `Finder.getQueryDescription` is gone: the main query's ROOT token (`Finder.getQueryRoot`) is what the
//    sub-query editor and the predict picker need from it.
//  - the "Predict" button NAVIGATES to the predict page instead of opening Signum's modal, so a
//    prediction has a shareable URL; the page shows the same component the modal would have.
//  - `PredictorClient.getResultRendered` is kept as `MachineLearningClient.getResultRendered` — the
//    registry that lets a result saver contribute its own view (the shipped one contributes the chart
//    buttons).

export default function Predictor(
    { ctx, ref }: { ctx: TypeContext<PredictorEntity>; ref?: React.Ref<IRenderButtons> },
): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const p = ctx.value;
    const queryKey = p.mainQuery?.query?.key;

    const mainQueryRoot = useAPI(
        () => queryKey == null ? Promise.resolve(undefined) : Finder.getQueryRoot(queryKey),
        [queryKey]);

    /**
     * "Predict about a row" — pick one from the predictor's own main query, then open the predict page.
     *
     * The picker deliberately SHOWS the predictor's own columns: those are the inputs the model reads, so
     * seeing them is how one judges whether a row is an interesting case before predicting about it.
     */
    async function handlePredictClick(): Promise<void> {
        if (queryKey == null)
            return;

        const lite = await Finder.find({
            queryName: queryKey,
            columnOptionsMode: "Add",
            columnOptions: p.columns.map(c => ({ token: c.token?.tokenString } as ColumnOption)),
        });

        if (lite == null)
            return;

        MachineLearningClient.navigateToPredict(p.toLite(), lite);
    }

    React.useImperativeHandle(ref, () => ({
        renderButtons(_bc: ButtonsContext): ButtonBarElement[] {
            if (p.state !== PredictorState.Trained)
                return [];
            return [{
                order: 10000,
                button: (
                    <button className="btn btn-info" onClick={() => void handlePredictClick()}>
                        <FontAwesomeIcon icon={["far", "lightbulb"]} />&nbsp;{PredictorMessage.Predict.niceToString()}
                    </button>
                ),
            }];
        },
    }), [p, p.state, queryKey]);

    function handleQueryChange(): void {
        // The filters and columns name the OLD query's tokens, so they are cleared.
        p.filters = [];
        p.columns = [];
        forceUpdate();
    }

    /**
     * Turning grouping ON invalidates every AGGREGATE token.
     *
     * A grouped query's columns are the group keys; an aggregate token there is not a key, so each one is
     * replaced by its parent (`Sum(TotalPrice)` becomes `TotalPrice`) rather than silently left to fail
     * at training time.
     */
    function handleGroupChange(): void {
        const fix = (t: QueryTokenEmbedded | null): QueryTokenEmbedded | null => {
            if (t?.token == null)
                return t;
            if (!p.mainQuery.groupResults || !t.token.isAggregate())
                return t;
            const parent = t.token.parent;
            if (parent == null)
                return null;
            return Object.assign(new QueryTokenEmbedded(), { token: parent, tokenString: parent.fullKey() });
        };

        p.filters.forEach(f => { f.token = fix(f.token); });
        p.columns.forEach(c => { c.token = fix(c.token)!; });
        forceUpdate();
    }

    /**
     * A NEW sub-query, pre-filled with its ParentKey column(s).
     *
     * Guessing the parent key is the whole value of the button: without grouping it is the main query's
     * entity, and with grouping it is one column per non-aggregate main column, in order. Getting that
     * wrong is the most common way a sub-query silently trains against the wrong population.
     */
    async function handleCreateSubQuery(): Promise<PredictorSubQueryEntity> {
        const mq = p.mainQuery;

        const tokens: QueryToken[] = !mq.groupResults
            // The ROOT entity token is the EMPTY string here (Signum spells it "Entity").
            ? [await Finder.parseSingleToken(mq.query.key, "", SubTokensOptions.CanElement)]
            : p.columns
                .map(c => c.token?.token)
                .filter((t): t is QueryToken => t != null && !t.isAggregate());

        const sq = new PredictorSubQueryEntity();
        sq.query = mq.query;
        sq.filters = [];
        sq.columns = tokens.map(t => {
            const col = new PredictorSubQueryEntity_Column();
            col.usage = PredictorSubQueryColumnUsage.ParentKey;
            col.token = Object.assign(new QueryTokenEmbedded(), { token: t, tokenString: t.fullKey() });
            return col;
        });
        return sq;
    }

    /** The chosen algorithm seeds its own settings row. */
    function handleAlgorithmChange(): void {
        if (p.algorithm == null)
            p.algorithmSettings = null!;
        else
            MachineLearningClient.initializeAlgorithm(p);
        forceUpdate();
    }

    /** A training run that finished (or failed) changed the ENTITY, so re-read the pack. */
    function handleTrainingFinished(): void {
        void Navigator.API.fetchEntityPack(p.toLite())
            .then(pack => ctx.frame?.onReload(pack));
    }

    async function handlePreviewMainQuery(e: React.MouseEvent<HTMLElement>): Promise<void> {
        if (queryKey == null || mainQueryRoot == null)
            return;

        const mq = p.mainQuery;
        const parsed = await toFilterOptionParsed(mainQueryRoot, p.filters,
            SubTokensOptions.CanElement | SubTokensOptions.CanAnyAll | canAggregate);

        const fo: FindOptions = {
            queryName: queryKey,
            groupResults: mq.groupResults,
            filterOptions: Finder.toFilterOptions(parsed),
            // Inputs first, then outputs — the shape the training table has.
            columnOptions: [...p.columns]
                .orderBy(a => a.usage)
                .map(c => ({ token: c.token?.tokenString } as ColumnOption)),
            columnOptionsMode: "ReplaceAll",
        };

        Finder.exploreWindowsOpen(fo, e);
    }

    // See the header: everything past Draft is a record of a run, not a definition to edit.
    if (p.state !== PredictorState.Draft)
        ctx = ctx.subCtx({ readOnly: true });

    const ctxxs = ctx.subCtx({ formSize: "xs" });
    const ctxxs4 = ctx.subCtx({ labelColumns: 4 });
    const ctxmq = ctxxs.subCtx(a => a.mainQuery);
    const canAggregate = p.mainQuery?.groupResults ? SubTokensOptions.CanAggregate : 0;

    return (
        <div>
            <div className="row">
                <div className="col-sm-6">
                    <AutoLine ctx={ctxxs4.subCtx(e => e.name)} readOnly={ctx.readOnly} />
                    <AutoLine ctx={ctxxs4.subCtx(e => e.state, { readOnly: true })} />
                    <EntityLine ctx={ctxxs4.subCtx(e => e.trainingException, { readOnly: true })} hideIfNull />
                </div>
                <div className="col-sm-6">
                    <EntityCombo ctx={ctxxs4.subCtx(f => f.algorithm)} onChange={handleAlgorithmChange} />
                    <EntityCombo ctx={ctxxs4.subCtx(f => f.resultSaver)} />
                    <EntityCombo ctx={ctxxs4.subCtx(f => f.publication)} readOnly />
                </div>
            </div>

            {p.state === PredictorState.Training &&
                <TrainingProgressComponent ctx={ctx} onStateChanged={handleTrainingFinished} />}

            <Tabs id={ctx.prefix + "_predictorTabs"} mountOnEnter unmountOnExit>
                <Tab eventKey="query" title={ctxmq.niceName(a => a.query)}>
                    <div>
                        <fieldset>
                            <legend>{ctxmq.niceName()}</legend>
                            <EntityLine ctx={ctxmq.subCtx(f => f.query)} remove={p.isNew} onChange={handleQueryChange} />
                            {queryKey && <div>
                                <AutoLine ctx={ctxmq.subCtx(f => f.groupResults)} onChange={handleGroupChange} />

                                <FilterBuilderEmbedded ctx={ctxxs.subCtx(a => a.filters)}
                                    queryKey={queryKey}
                                    subTokenOptions={SubTokensOptions.CanAnyAll | SubTokensOptions.CanElement | canAggregate} />

                                <EntityTable ctx={ctxxs.subCtx(e => e.columns)} columns={[
                                    { property: a => a.usage },
                                    {
                                        property: a => a.token,
                                        template: (cctx, row) => <QueryTokenEmbeddedBuilder
                                            ctx={cctx.subCtx(a => a.token, { formGroupStyle: "SrOnly" })}
                                            queryKey={queryKey}
                                            subTokenOptions={SubTokensOptions.CanElement | canAggregate}
                                            onTokenChanged={() => {
                                                initializeColumn(cctx.value, cctx.value.token?.token);
                                                row.forceUpdate();
                                            }} />,
                                        headerHtmlAttributes: { style: { width: "40%" } },
                                    },
                                    { property: a => a.encoding },
                                    { property: a => a.nullHandling },
                                ]} />

                                <LinkButton title={undefined} onClick={e => void handlePreviewMainQuery(e)}>
                                    {PredictorMessage.Preview.niceToString()}
                                </LinkButton>
                            </div>}
                        </fieldset>

                        {queryKey && <EntityTabRepeater ctx={ctxxs.subCtx(e => e.subQueries)}
                            onCreate={handleCreateSubQuery}
                            getTitle={(mctx: TypeContext<PredictorSubQueryEntity>) =>
                                mctx.value.name || PredictorSubQueryEntity.niceName()}
                            getComponent={mctx =>
                                <PredictorSubQuery ctx={mctx} mainQuery={p.mainQuery} mainQueryRoot={mainQueryRoot} />} />}
                    </div>
                </Tab>

                <Tab eventKey="settings" title={ctxxs.niceName(a => a.settings)}>
                    {p.algorithm && <EntityDetail ctx={ctxxs.subCtx(f => f.algorithmSettings) as unknown as TypeContext<BaseEntity | null>} remove={false} />}
                    <EntityDetail ctx={ctxxs.subCtx(f => f.settings)} remove={false} />
                </Tab>

                {p.state !== PredictorState.Draft &&
                    <Tab eventKey="codifications" title={PredictorMessage.Codifications.niceToString()}>
                        <SearchControl findOptions={PredictorCodificationEntity.findOptions(token => ({
                            filterOptions: [token(e => e.predictor).filter("EqualTo", p.toLite(), { frozen: true })],
                        }))} />
                    </Tab>}

                {p.state !== PredictorState.Draft &&
                    <Tab eventKey="progress" title={PredictorMessage.Progress.niceToString()}>
                        {p.state === PredictorState.Trained && <EpochProgressComponent ctx={ctx} />}
                        <SearchControl findOptions={PredictorEpochProgressEntity.findOptions(token => ({
                            filterOptions: [token(e => e.predictor).filter("EqualTo", p.toLite(), { frozen: true })],
                            orderOptions: [token(e => e.epoch).order("Ascending")],
                        }))} />
                    </Tab>}

                {p.state === PredictorState.Trained &&
                    <Tab eventKey="files" title={PredictorMessage.Results.niceToString()}>
                        <div className="row">
                            {p.resultTraining && p.resultValidation && <>
                                <MetricsPanel ctx={ctx.subCtx(a => a.resultTraining!)} title={trainingTitle(ctx)} />
                                <MetricsPanel ctx={ctx.subCtx(a => a.resultValidation!)} title={validationTitle(ctx)} />
                            </>}
                            {p.classificationTraining && p.classificationValidation && <>
                                <ClassificationMetricsPanel ctx={ctx.subCtx(a => a.classificationTraining!)} title={trainingTitle(ctx)} />
                                <ClassificationMetricsPanel ctx={ctx.subCtx(a => a.classificationValidation!)} title={validationTitle(ctx)} />
                            </>}
                            {p.regressionTraining && p.regressionValidation && <>
                                <RegressionMetricsPanel ctx={ctx.subCtx(a => a.regressionTraining!)} title={trainingTitle(ctx)} />
                                <RegressionMetricsPanel ctx={ctx.subCtx(a => a.regressionValidation!)} title={validationTitle(ctx)} />
                            </>}
                        </div>

                        {p.resultSaver && MachineLearningClient.getResultRendered(ctx)}

                        <EntityRepeater ctx={ctxxs.subCtx(f => f.files)} getComponent={ec =>
                            <FileLine ctx={ec.subCtx(a => a.element, { formGroupStyle: "SrOnly" })}
                                containerEntity={p} remove={false} fileType={PredictorFileType.PredictorFile} />} />
                    </Tab>}
            </Tabs>
        </div>
    );
}

function trainingTitle(ctx: TypeContext<PredictorEntity>): string {
    return ctx.niceName(a => a.resultTraining);
}

function validationTitle(ctx: TypeContext<PredictorEntity>): string {
    return ctx.niceName(a => a.resultValidation);
}

// ---- the live training panel ---------------------------------------------------------------------------

/**
 * The run in flight.
 *
 * It polls twice a second, which is what makes it useful: a training that has stopped improving is
 * visible in the curve long before it finishes, and the whole point of showing it is to let someone stop
 * a run that is going nowhere. `avoidReset` keeps the previous answer on screen while the next is in
 * flight, so the chart does not blink.
 */
export function TrainingProgressComponent(
    p: { ctx: TypeContext<PredictorEntity>; onStateChanged: () => void },
): React.JSX.Element {
    const tick = useInterval(500, 0, n => n + 1);

    const tp = useAPI<TrainingProgress | undefined>(
        (_signal, previous) => MachineLearningClient.API.trainingProgress(p.ctx.value.toLite())
            .then(next => {
                // The state changed under us — the run finished, stopped or failed, so the ENTITY is
                // stale and the frame must re-read it.
                if (previous != null && previous.state !== next.state)
                    p.onStateChanged();
                return next;
            }),
        [tick, p.ctx.value], { avoidReset: true });

    return (
        <div>
            {tp?.epochProgresses && <LossChart height={200} rows={tp.epochProgresses} />}
            <ProgressBar
                value={tp?.progress ?? null}
                color={tp == null || !tp.running ? "warning" : undefined}
                message={tp == null ? PredictorMessage.StartingTraining.niceToString() : tp.message} />
        </div>
    );
}

/** The recorded curve of a finished run. */
export function EpochProgressComponent(p: { ctx: TypeContext<PredictorEntity> }): React.JSX.Element {
    const rows = useAPI(() => MachineLearningClient.API.epochProgress(p.ctx.value.toLite()), [p.ctx.value]);

    return <div>{rows && <LossChart height={200} rows={rows} />}</div>;
}

/**
 * A local `ProgressBar` — Signum's lives in its framework.
 *
 * A null value is an INDETERMINATE step — "preprocessing" has no percentage — and it is drawn striped
 * and full rather than empty, because an empty bar reads as "nothing is happening".
 */
export function ProgressBar(
    p: { value: number | null; message?: string | null; color?: string },
): React.JSX.Element {
    const indeterminate = p.value == null;
    const percent = indeterminate ? 100 : Math.max(0, Math.min(100, p.value! * 100));

    return (
        <div className="progress my-2" style={{ height: "1.5rem" }}>
            <div className={`progress-bar${indeterminate ? " progress-bar-striped progress-bar-animated" : ""}`
                + (p.color ? ` bg-${p.color}` : "")}
                role="progressbar" style={{ width: `${percent}%` }}
                aria-valuenow={indeterminate ? undefined : percent} aria-valuemin={0} aria-valuemax={100}>
                {p.message}{!indeterminate && ` (${percent.toFixed(0)}%)`}
            </div>
        </div>
    );
}

/** Whether a predictor's settings are a neural network — the loss chart's series titles read it. */
export function neuralNetworkSettingsOf(p: PredictorEntity): NeuralNetworkSettingsEntity | undefined {
    return p.algorithmSettings instanceof NeuralNetworkSettingsEntity ? p.algorithmSettings : undefined;
}
