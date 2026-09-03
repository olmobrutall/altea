import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { StyleContext, TypeContext } from "@altea/altea/client/TypeContext";
import { Binding, ReadonlyBinding } from "@altea/altea/client/binding";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityCombo } from "@altea/altea/client/Lines/EntityCombo";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EnumLine } from "@altea/altea/client/Lines/EnumLine";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import { NumberBox } from "@altea/altea/client/Lines/NumberLine";
import { Finder } from "@altea/altea/client/Finder";
import { Navigator } from "@altea/altea/client/Navigator";
import { AbortableRequest } from "@altea/altea/client/Services";
import { toNumberFormat } from "@altea/altea/client/numberFormat";
import { SubTokensOptions } from "@altea/altea/client/QueryToken";
import type { QueryToken } from "@altea/altea/client/QueryToken";
import { useAPI, useForceUpdate } from "@altea/altea/client/Hooks";
import { Lite } from "@altea/altea/data/lite";
import { isNumber } from "@altea/altea/data/globals";
import type { BaseEntity, Entity } from "@altea/altea/data/entity";
import {
    PredictorColumnUsage, PredictorEntity, PredictorMessage,
} from "../../data/Predictor";
import {
    isPredictOutputTuple,
    type AlternativePrediction, type PredictColumnModel, type PredictRequestModel,
    type PredictSubQueryTableModel, type PredictorHeaderType,
} from "../../data/PredictRequest";
import { MachineLearningClient } from "../MachineLearningClient";

// Port of Signum.MachineLearning's Templates/PredictModal.tsx — an INTERACTIVE prediction.
//
// What makes it interesting rather than a read-out: every input is editable and every edit re-predicts,
// so the page answers "what would have to be different?" rather than just "what does the model say". The
// original values stay on screen while an edited prediction is in flight (dimmed), which is the only way
// to see what the change did.
//
// altea divergences, documented inline:
//  - it is a PAGE-shaped component (Signum's is a modal). Same content; a prediction then has a URL, and
//    the designer's Predict button navigates rather than opening a dialog.
//  - a token arrives as a STRING and is resolved here through `Finder.TokenCompleter` (altea has no
//    QueryDescription, so tokens are a client-side model — see data/PredictRequest.ts). One completer per
//    query, so the whole page costs one resolution pass.
//  - a value editor is a `TypeContext` built off the TOKEN's TypeReference, which is altea's way of
//    rendering a value with no property route (`AutoLine` then dispatches) — Signum passes an explicit
//    `type=` prop, which altea's Lines do not have.
//  - `AbortableRequest` keeps Signum's coalescing: typing in an input fires one request per keystroke and
//    only the last answer may land.

interface PredictViewProps {
    initialPredict: PredictRequestModel;
    /** The entity predicted about, when the prediction was opened from a row. */
    entity?: Lite<Entity> | null;
    /** Whether to offer the "show N alternatives" checkbox — only a classification has alternatives. */
    isClassification: boolean;
}

export function PredictView(p: PredictViewProps): React.JSX.Element {
    const [predict, setPredict] = React.useState<PredictRequestModel>(p.initialPredict);
    const [hasChanged, setHasChanged] = React.useState(false);

    // One in-flight update at a time, latest wins — Signum's same AbortableRequest.
    const updater = React.useMemo(
        () => new AbortableRequest((signal, request: PredictRequestModel) =>
            MachineLearningClient.API.updatePredict(request, signal)), []);

    function handleChange(): void {
        setHasChanged(true);
        void updater.getData(predict).then(next => setPredict(next));
    }

    // Every token the page renders, resolved in one pass against each query's root.
    const tokens = useAPI(() => resolveTokens(predict), [predict.predictor.key()]);

    const sctx = React.useMemo(() => new StyleContext(undefined, {}), []);

    if (tokens == null)
        return <div className="mt-3">…</div>;

    const inputs = predict.columns.filter(c => c.usage === PredictorColumnUsage.Input);
    const outputs = predict.columns.filter(c => c.usage === PredictorColumnUsage.Output);

    return (
        <div>
            <h4>
                {predict.predictor.toString()}{" "}
                <small className="text-muted">
                    {PredictorEntity.niceName()} {predict.predictor.id}{" "}
                    (<a href={Navigator.navigateRoute(predict.predictor)} target="_blank" rel="noreferrer">
                        {PredictorMessage.Predict.niceToString()}
                    </a>)
                </small>
            </h4>

            <div>
                {inputs.map((col, i) => <PredictLine key={`in${i}`} sctx={sctx}
                    token={tokens.get(col.token)} usage="Input"
                    hasOriginal={predict.hasOriginal} hasChanged={hasChanged}
                    binding={Binding.create(col, c => c.value)} onChange={handleChange} />)}
            </div>

            {predict.subQueries.map((table, i) =>
                <PredictTable key={`sq${i}`} sctx={sctx} table={table} tokens={tokens}
                    hasOriginal={predict.hasOriginal} hasChanged={hasChanged} onChange={handleChange} />)}

            <div>
                {outputs.map((col, i) => <PredictLine key={`out${i}`} sctx={sctx}
                    token={tokens.get(col.token)} usage="Output"
                    hasOriginal={predict.hasOriginal} hasChanged={hasChanged}
                    binding={Binding.create(col, c => c.value)} onChange={handleChange} />)}
            </div>

            {p.isClassification &&
                <AlternativesCheckBox binding={Binding.create(predict, a => a.alternativesCount)}
                    onChange={handleChange} />}
        </div>
    );
}

export default PredictView;

/**
 * Resolve every token STRING in the model, one completer per query.
 *
 * The main query's tokens and each sub-query's are resolved against their OWN root, which is why this is
 * keyed by the token string rather than by position: two queries may spell the same token differently.
 */
async function resolveTokens(predict: PredictRequestModel): Promise<Map<string, QueryToken>> {
    const result = new Map<string, QueryToken>();
    const options = SubTokensOptions.CanElement | SubTokensOptions.CanAggregate | SubTokensOptions.CanAnyAll;

    const predictor = await Navigator.API.fetch(predict.predictor as Lite<PredictorEntity>);

    async function resolve(queryKey: string, tokenStrings: string[]): Promise<void> {
        if (tokenStrings.length === 0)
            return;
        const root = await Finder.getQueryRoot(queryKey);
        const completer = new Finder.TokenCompleter(root);
        for (const ts of tokenStrings)
            completer.request(ts);
        await completer.finished();
        for (const ts of tokenStrings)
            result.set(ts, completer.get(ts, options));
    }

    await resolve(predictor.mainQuery.query.key, predict.columns.map(c => c.token));

    for (const table of predict.subQueries) {
        const sq = predictor.subQueries.find(s => s.id === table.subQuery.id);
        if (sq != null)
            await resolve(sq.query.key, table.columnHeaders.map(h => h.token));
    }

    return result;
}

/**
 * Signum's `AlternativesCheckBox` — ask a classification for its N most likely answers.
 *
 * Worth having because a classifier's confidence is the useful part: "Shipped, 62%; Cancelled, 31%" says
 * something the single winner does not.
 */
export function AlternativesCheckBox(
    p: { binding: Binding<number | null>; onChange: () => void },
): React.JSX.Element {
    const forceUpdate = useForceUpdate();

    function setValue(val: number | null): void {
        p.binding.setValue(val);
        forceUpdate();
        p.onChange();
    }

    const val = p.binding.getValue();
    return (
        <label className="d-flex align-items-center gap-2">
            <input type="checkbox" className="form-check-input mt-0"
                checked={val != null} onChange={() => setValue(val == null ? 5 : null)} />
            Show
            <NumberBox value={val} onChange={n => setValue(n == null ? null : Number(n))} validateKey={isNumber} format={toNumberFormat("0")} />
            alternative predictions
        </label>
    );
}

interface PredictLineProps {
    binding: Binding<unknown>;
    token: QueryToken | undefined;
    usage: PredictorHeaderType;
    sctx: StyleContext;
    hasOriginal: boolean;
    hasChanged: boolean;
    onChange: () => void;
}

/** One value: an editable input, a key, or the prediction (beside the truth, when there is one). */
export function PredictLine(p: PredictLineProps): React.JSX.Element {
    const token = p.token;

    function renderValue(): React.ReactNode {
        if (token == null)
            return <span className="text-danger">?</span>;

        if (p.usage === "Input") {
            const ctx = new TypeContext<unknown>(p.sctx, undefined, token.type, p.binding);
            return <PredictValue token={token} ctx={ctx} onChange={p.onChange} />;
        }

        if (p.usage === "Key") {
            const ctx = new TypeContext<unknown>(p.sctx, { readOnly: true }, token.type, p.binding);
            return <PredictValue token={token} ctx={ctx} />;
        }

        // An OUTPUT. With an original, both are shown; the original is dimmed while an edited prediction
        // is in flight, because it no longer describes what is on screen.
        const value = p.binding.getValue();
        if (p.hasOriginal && isPredictOutputTuple(value)) {
            const octx = new TypeContext<unknown>(p.sctx, { readOnly: true }, token.type,
                Binding.create(value, a => a.original));
            const pctx = new TypeContext<unknown>(p.sctx, { readOnly: true }, token.type,
                Binding.create(value, a => a.predicted));

            return (
                <div>
                    <div style={{ opacity: p.hasChanged ? 0.5 : 1 }}>
                        <PredictValue token={token} ctx={octx} label={<FontAwesomeIcon icon="bullseye" />} />
                    </div>
                    {renderPredicted(pctx, octx.value)}
                </div>
            );
        }

        const ctx = new TypeContext<unknown>(p.sctx, { readOnly: true }, token.type, p.binding);
        return renderPredicted(ctx, null);
    }

    function renderPredicted(pctx: TypeContext<unknown>, original: unknown): React.ReactNode {
        if (!Array.isArray(pctx.value))
            return <PredictValue token={token!} ctx={pctx}
                label={<FontAwesomeIcon icon={["far", "lightbulb"]} color={colorFor(pctx.value, original)} />} />;

        // The ALTERNATIVES, each labelled with its probability.
        const predictions = pctx.value as AlternativePrediction[];
        const percent = toNumberFormat("P2");
        return (
            <div>
                {predictions.map((a, i) =>
                    <PredictValue key={i} token={token!}
                        ctx={new TypeContext<unknown>(p.sctx, { readOnly: true }, token!.type,
                            new ReadonlyBinding(a.value, `_alt${i}`))}
                        label={<i style={{ color: colorFor(a.value, original) }}>{percent.format(a.probability)}</i>}
                        labelHtmlAttributes={{ style: { textAlign: "right", whiteSpace: "nowrap" } }} />)}
            </div>
        );
    }

    /** Green when the model agreed with reality, red when it did not — nothing when there is no truth. */
    function colorFor(predicted: unknown, original: unknown): string | undefined {
        if (!p.hasOriginal)
            return undefined;
        const same = predicted === original
            || (predicted instanceof Lite && original instanceof Lite && predicted.is(original));
        return same ? "green" : "red";
    }

    return (
        <FormGroup ctx={p.sctx} label={token?.niceName() ?? "?"}
            labelHtmlAttributes={{ title: token == null ? undefined : fullNiceName(token) }}>
            {() => renderValue()}
        </FormGroup>
    );
}

interface PredictTableProps {
    sctx: StyleContext;
    table: PredictSubQueryTableModel;
    tokens: Map<string, QueryToken>;
    hasChanged: boolean;
    hasOriginal: boolean;
    onChange: () => void;
}

/**
 * One sub-query, as a table: a row per SplitBy key, a column per header.
 *
 * The layout is what makes a flattened one-to-many readable — "one row per month, the sales in it" — and
 * a key column is marked with a key icon because a key is not something the model reads, it is what
 * decides which slot the values land in.
 */
export function PredictTable(p: PredictTableProps): React.JSX.Element {
    const sctx = React.useMemo(() => new StyleContext(p.sctx, { formGroupStyle: "SrOnly" }), [p.sctx]);
    const { subQuery, columnHeaders, rows } = p.table;

    return (
        <div>
            <h4>{subQuery.toString()}</h4>
            <div style={{ maxHeight: "500px", overflowY: "auto", marginBottom: "10px" }}>
                <table className="table table-sm">
                    <thead>
                        <tr>
                            {columnHeaders.map((h, i) => {
                                const token = p.tokens.get(h.token);
                                return (
                                    <th key={i} className={`header-${h.headerType.toLowerCase()}`}
                                        title={token == null ? undefined : fullNiceName(token)}>
                                        {h.headerType === "Key" &&
                                            <FontAwesomeIcon icon="key" style={{ marginRight: "10px" }} />}
                                        {token?.niceName() ?? h.token}
                                    </th>
                                );
                            })}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, j) =>
                            <tr key={j}>
                                {row.map((_v, i) => {
                                    const h = columnHeaders[i]!;
                                    return (
                                        <td key={i}>
                                            <PredictLine sctx={sctx} token={p.tokens.get(h.token)}
                                                binding={new Binding(row, i)} usage={h.headerType}
                                                hasChanged={p.hasChanged} hasOriginal={p.hasOriginal}
                                                onChange={p.onChange} />
                                        </td>
                                    );
                                })}
                            </tr>)}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

/** Signum's `fullNiceName` — the whole path, for the cell's tooltip. */
function fullNiceName(token: QueryToken): string {
    const parent = token.parent ? `${fullNiceName(token.parent)}.` : "";
    return `${parent}[${token.niceName()}]`;
}

interface PredictValueProps {
    token: QueryToken;
    ctx: TypeContext<unknown>;
    onChange?: () => void;
    label?: React.ReactElement;
    labelHtmlAttributes?: React.LabelHTMLAttributes<HTMLLabelElement>;
}

/**
 * Signum's `PredictValue` — the right editor for a token's type.
 *
 * The one non-obvious branch is Signum's and is kept: a Lite of a LOW-POPULATION type gets a combo (you
 * can see all the options), anything else an autocomplete line. Everything else falls to `AutoLine`,
 * which dispatches on the TypeReference the context carries.
 */
export function PredictValue(p: PredictValueProps): React.JSX.Element {
    const ctx = p.ctx.subCtx({ labelColumns: 1 });
    const token = p.token;
    const handleChange = (): void => p.onChange?.();

    switch (token.filterType) {
        case "Lite": {
            const typeInfos = token.type.typeInfos();
            const useLine = typeInfos.length === 0 || typeInfos.some(ti => !ti.lowPopulation);
            const entityCtx = ctx as unknown as TypeContext<BaseEntity | Lite<Entity> | null>;
            return useLine
                ? <EntityLine ctx={entityCtx} create={false} label={p.label}
                    labelHtmlAttributes={p.labelHtmlAttributes} onChange={handleChange} />
                : <EntityCombo ctx={entityCtx as TypeContext<Entity | Lite<Entity> | null>} create={false} label={p.label}
                    labelHtmlAttributes={p.labelHtmlAttributes} onChange={handleChange} />;
        }
        case "Enum":
            return <EnumLine ctx={ctx as TypeContext<string | number | null>}
                format={token.format} unit={token.unit} label={p.label}
                labelHtmlAttributes={p.labelHtmlAttributes} onChange={handleChange} />;
        default:
            return <AutoLine ctx={ctx} format={token.format} unit={token.unit} label={p.label}
                labelHtmlAttributes={p.labelHtmlAttributes} onChange={handleChange} />;
    }
}

/** Whether a column model is an editable input — exported for the page's own header. */
export function isInput(col: PredictColumnModel): boolean {
    return col.usage === PredictorColumnUsage.Input;
}
