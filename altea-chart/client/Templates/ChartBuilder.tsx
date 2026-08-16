import * as React from 'react'
import { TypeContext, mlistItemContext } from '@altea/altea/client/TypeContext'
import { ChartColumnEmbedded } from '../../data/ChartColumn'
import { ChartParameterEmbedded } from '../../data/ChartParameter'
import { ChartMessage } from '../../data/ChartMessage'
import { ChartClient } from '../ChartClient'
import { ChartColumn } from './ChartColumn'
import { ColorInterpolate, ColorScheme } from '../ColorPalette/ColorPaletteClient'
import { useForceUpdate, useAPI } from '@altea/altea/client/Hooks'
import { colorInterpolators, colorSchemes } from '../ColorPalette/ColorUtils'
import { Dic } from '@altea/altea/data/globals/index'
import { Finder } from '@altea/altea/client/Finder'
import { Temporal, toInt } from '@altea/altea/data/basics'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import ChartTimeSeries from './ChartTimeSeries'
import { ChartTimeSeriesEmbedded } from '../../data/ChartRequest'
import type { IChartBase } from '../../data/ChartRequest'
import { EnumLine } from '@altea/altea/client/Lines/EnumLine'
import type { EnumLineProps, OptionItem } from '@altea/altea/client/Lines/EnumLine'
import { NumberLine, NumberBox, isDecimalKey } from '@altea/altea/client/Lines/NumberLine'
import { TextBoxLine } from '@altea/altea/client/Lines/TextBoxLine'
import type { TextBoxLineProps } from '@altea/altea/client/Lines/TextBoxLine'
import { FormGroup } from '@altea/altea/client/Lines/FormGroup'
import { toNumberFormat } from '@altea/altea/client/numberFormat'
import '@altea/altea/data/globals/arrayExtensions'
import '@altea/altea/data/globals/stringExtensions'

// Copy-and-fix of Signum.Chart/Templates/ChartBuilder.tsx. altea divergences: @framework/* → altea; MList
// `.element` → plain arrays; `is(symbol)` → key compare; icons are deferred (string|null, always null) so
// the chart-type buttons show the symbol's nice name text instead of a base64 <img>; the QueryDescription
// prop is dropped (altea has no QueryDescription — the system-time gate resolves the query root token via
// Finder.getQueryRoot instead); `.modified` drops (dirty is snapshot-tracked, so forceUpdate() stands in);
// luxon → Temporal for the ChartTimeSeries defaults; ChartColumnType is numeric (nice name via
// ChartClient.chartColumnTypeNiceName); EnumValueList is `{ values }`.

export interface ChartBuilderProps {
  ctx: TypeContext<IChartBase>; /*IChart*/
  queryKey: string;
  maxRowsReached?: boolean;
  onInvalidate: () => void;
  onTokenChange: () => void;
  onRedraw: () => void;
  onOrderChanged: () => void;
}

export default function ChartBuilder(p: ChartBuilderProps): React.JSX.Element {
  const forceUpdate = useForceUpdate();

  const chartScripts = useAPI(() => ChartClient.getChartScripts(), []);

  const queryRoot = useAPI(() => Finder.getQueryRoot(p.queryKey), [p.queryKey]);

  function chartTypeImgClass(script: ChartClient.ChartScript): string {
    const cb = p.ctx.value;

    let css = "sf-chart-img";

    if (!cb.columns.some(a => a.token != undefined && a.token.parseException != undefined) && ChartClient.isCompatibleWith(script, cb))
      css += " sf-chart-img-equiv";

    if (cb.chartScript?.key == script.symbol.key)
      css += " sf-chart-img-curr";

    return css;
  }

  function handleOnRedraw() {
    forceUpdate();
    p.onRedraw();
  }

  function handleChartScriptOnClick(cs: ChartClient.ChartScript) {
    const chart = p.ctx.value;
    let compatible = ChartClient.isCompatibleWith(cs, chart)
    chart.chartScript = cs.symbol;
    ChartClient.synchronizeColumns(chart, cs);

    if (!compatible)
      p.onInvalidate();
    else
      p.onRedraw();
  }

  function handleOrderChart(c: ChartColumnEmbedded, e: React.MouseEvent<any>) {
    ChartClient.handleOrderColumn(p.ctx.value, c, e.shiftKey);
    p.onOrderChanged();
  }

  const chart = p.ctx.value;

  const chartScript = chartScripts?.single(cs => cs.symbol.key == chart.chartScript?.key);

  var parameterDic = mlistItemContext(p.ctx.subCtx(c => c.parameters, { formSize: "xs", formGroupStyle: "Basic" })).toObject(a => a.value.name!);

  // Signum's `(qs?.allowSystemTime ?? tis.some(a => a.isSystemVersioned))`. altea has no QueryDescription;
  // the query root token (Finder.getQueryRoot) carries the entity type, whose TypeInfos expose
  // `systemVersioned` (mirrors SearchControl's gate). `tis` is empty until the root token resolves.
  const qs = Finder.getSettings(p.queryKey);
  const tis = queryRoot?.type.typeInfos() ?? [];

  return (<>
    {(qs?.allowSystemTime ?? tis.some(a => a.systemVersioned != null)) && <div className='d-flex align-items-center mb-3' style={{ minHeight: 34 }}>
      <label>
        <input className='me-1' type={'checkbox'} defaultChecked={chart.chartTimeSeries != null}
          onChange={e => {

            if (e.target.checked) {
              if (!chart.chartTimeSeries) {
                const ts = new ChartTimeSeriesEmbedded();
                ts.timeSeriesStep = toInt(1);
                ts.timeSeriesUnit = 'Month';
                ts.startDate = Temporal.Now.plainDateISO().with({ month: 1, day: 1 }).toString();
                ts.endDate = Temporal.Now.plainDateISO().toString();
                ts.splitQueries = true;
                chart.chartTimeSeries = ts;
              }
            } else {
              chart.chartTimeSeries = null;
            }
            forceUpdate();
          }}
        />
        Time machine
        <FontAwesomeIcon aria-hidden={true} className='mx-1' icon='clock-rotate-left' />
      </label>
      {chart.chartTimeSeries && <ChartTimeSeries chartTimeSeries={chart.chartTimeSeries} chartBase={p.ctx.value} onChange={handleOnRedraw} />}
    </div>}
    <div className="row sf-chart-builder gx-2">
      <div className="col-lg-2">
        <div className="sf-chart-type card bg-body rounded shadow-sm border-0 p-2">
          <div className="card-header" style={{ backgroundColor: "inherit" }}>
            <h2 className="mb-3 card-title h6">{ChartMessage.ChartType.niceToString()}</h2>
          </div>
          <div className="card-body">
            {chartScripts?.map((cs, i) =>
              <button
                key={i}
                type="button"
                className={`sf-chart-button ${chartTypeImgClass(cs)}`}
                style={{ background: "inherit", border: "inherit" }}
                title={ChartClient.symbolNiceName(cs.symbol)}
                onClick={() => handleChartScriptOnClick(cs)}>
                {/* the server ships the icon as a data-URI (loadIcon); fall back to the name if absent */}
                {cs.icon ? <img src={cs.icon} alt={ChartClient.symbolNiceName(cs.symbol)} /> : ChartClient.symbolNiceName(cs.symbol)}
              </button>)}
          </div>
          <div className="card-body">
            <NumberLine ctx={p.ctx.subCtx(a => a.maxRows, { formGroupStyle: "Basic", formSize: "xs" })} valueHtmlAttributes={{ className: p.maxRowsReached ? "text-danger fw-bold" : undefined }} />
          </div>
        </div>
      </div >
      <div className="col-lg-10">
        <div className="sf-chart-tokens card bg-body rounded shadow-sm border-0 p-2">
          <div className="card-header" style={{ backgroundColor: "inherit" }}>
            <h2 className="mb-3 card-title h6">{ChartMessage.ChartSettings.niceToString()}</h2>
          </div>
          <div>
            <div className="card-body">
              <table className="table table-borderless" style={{ marginBottom: "-1px" }}>
                <thead>
                  <tr>
                    <th className="sf-chart-token-narrow">
                      {ChartMessage.Dimension.niceToString()}
                    </th>
                    <th className="sf-chart-token-wide">
                      Token
                    </th>
                  </tr>
                </thead>
                <tbody>

                  {chartScript && mlistItemContext(p.ctx.subCtx(c => c.columns, { formSize: "xs" })).map((ctx, i) =>
                    <ChartColumn chartBase={chart} chartScript={chartScript} ctx={ctx} key={"C" + i} scriptColumn={chartScript!.columns[i]}
                      queryKey={p.queryKey} onTokenChange={() => handleTokenChange(ctx.value, chart, chartScript!, forceUpdate, p.onTokenChange)}
                      onRedraw={handleOnRedraw}
                      onOrderChanged={handleOrderChart} columnIndex={i} parameterDic={parameterDic} />)
                  }
                </tbody>
              </table>
            </div>
          </div>
        </div>
        {chartScript && <Parameters chart={p.ctx.value} chartScript={chartScript} parameterDic={parameterDic} onRedraw={handleOnRedraw} />}
      </div>
    </div >
  </>
  );
}

function handleTokenChange(cc: ChartColumnEmbedded, chart: IChartBase, chartScript: ChartClient.ChartScript, forceUpdate: () => void, onTokenChange: () => void) {
  cc.displayName = null;
  cc.format = null;
  ChartClient.synchronizeColumns(chart, chartScript);
  forceUpdate();
  onTokenChange();
}

export function Parameters(props: {
  chartScript: ChartClient.ChartScript,
  chart: IChartBase,
  onRedraw?: () => void,
  parameterDic: { [name: string]: TypeContext<ChartParameterEmbedded> },
}): React.JSX.Element | null {


  var groups = props.chartScript.parameterGroups
    .filter(gr => gr.parameters.some(param => param.columnIndex == null))
    .map((gr, i) =>
      <div className={"col-sm-2"} key={i} >
        {gr.name && < span style={{ color: "gray", textDecoration: "underline" }}>{gr.name}</span>}
        {gr.parameters
          .filter(a => a.columnIndex == null)
          .map((sp, j) => props.parameterDic[sp.name] ?
            <ParameterValueLine key={sp.name} ctx={props.parameterDic[sp.name]} scriptParameter={sp} chart={props.chart} onRedraw={props.onRedraw} /> :
            <p key={sp.name} className="text-danger">{sp.name} ({sp.displayName})</p>)}
      </div>
    );

  if (groups.length == 0)
    return null;

  return (
    <fieldset className="sf-chart-parameters bg-body rounded shadow-sm border-0 my-1 p-2">
      <div className="row">
        {groups}
      </div>
    </fieldset>
  );
}

export function ColumnParameters(props: {
  chartScript: ChartClient.ChartScript,
  chart: IChartBase,
  onRedraw?: () => void,
  parameterDic: { [name: string]: TypeContext<ChartParameterEmbedded> },
  columnIndex: number
}): React.JSX.Element | null {


  var groups = props.chartScript.parameterGroups
    .filter(gr => gr.parameters.some(param => param.columnIndex == props.columnIndex))
    .map((gr, i) =>
      <div key={i} >
        {gr.name && < div style={{ color: "gray", textDecoration: "underline" }}>{gr.name}</div>}
        <div className="row">
          {gr.parameters
            .filter(a => a.columnIndex == props.columnIndex)
            .map((sp, j) =>
              <div className={"col-sm-3"} key={sp.name}>
                {props.parameterDic[sp.name] ?
                  <ParameterValueLine key={sp.name} ctx={props.parameterDic[sp.name]} scriptParameter={sp} chart={props.chart} onRedraw={props.onRedraw} /> :
                  <p key={sp.name} className="text-danger">{sp.name} ({sp.displayName})</p>
                }
              </div>
            )}
        </div>
      </div>
    );

  if (groups.length == 0)
    return null;

  return (
    <div className="sf-chart-parameters">
      {groups}
    </div>
  );
}

function ParameterValueLine({ ctx, scriptParameter, chart, onRedraw }: { ctx: TypeContext<ChartParameterEmbedded>, scriptParameter: ChartClient.ChartScriptParameter, onRedraw?: () => void, chart: IChartBase }) {

  if (scriptParameter.type == "Special") {
    var sp = scriptParameter.valueDefinition as ChartClient.SpecialParameter;

    if (sp.specialParameterType == "ColorCategory") {
      return (
        <EnumLine ctx={ctx.subCtx(a => a.value)} label={scriptParameter.displayName} onChange={onRedraw}
          optionItems={Dic.getKeys(colorSchemes)}
          onRenderDropDownListItem={oi => <div style={{ display: "flex", alignItems: "center", userSelect: "none" }}>
            <ColorScheme colorScheme={oi.value as string} />
            {oi.label}
          </div>} />
      );
    }

    if (sp.specialParameterType == "ColorInterpolate") {
      return (
        <EnumLine ctx={ctx.subCtx(a => a.value)} label={scriptParameter.displayName} onChange={onRedraw}
          optionItems={Dic.getKeys(colorInterpolators).map(a => (ctx.value.value?.startsWith("-") ? "-" : "") + a)}
          onRenderDropDownListItem={oi => <div style={{ display: "flex", alignItems: "center", userSelect: "none" }}>
            <ColorInterpolate colorInterpolator={oi.value as string} />
            {oi.label}
          </div>}
          helpText={<label>
            <input type="checkbox" className="form-check me-2"
              checked={ctx.value.value?.startsWith("-")}
              onChange={e => {
                if (ctx.value.value)
                  ctx.value.value = e.currentTarget.checked ? ("-" + ctx.value.value) : ctx.value.value.after("-");

                onRedraw?.();
              }} />
            Invert
          </label>}
        />
      );
    }

    throw new Error("Unexpected SpecialParameterType = " + sp.specialParameterType);
  }

  const token = scriptParameter.columnIndex == undefined ? undefined :
    chart.columns[scriptParameter.columnIndex].token?.token;

  if (scriptParameter.type == "Number" || scriptParameter.type == "String") {
    const tbl: TextBoxLineProps = {
      ctx: ctx.subCtx(a => a.value),
      label: scriptParameter.displayName!,
    };
    tbl.valueHtmlAttributes = { onBlur: onRedraw };
    if (ctx.value.value != ChartClient.defaultParameterValue(scriptParameter, token))
      tbl.labelHtmlAttributes = { style: { fontWeight: "bold" } };
    return <TextBoxLine {...tbl} />;
  }
  else if (scriptParameter.type == "Enum") {
    const el: EnumLineProps<string | null> = {
      ctx: ctx.subCtx(a => a.value),
      label: scriptParameter.displayName!,
    };

    const values = (scriptParameter.valueDefinition as ChartClient.EnumValueList).values;

    if (values.length <= 1)
      el.ctx.styleOptions.readOnly = true;

    el.optionItems = values.map(ev => ({
      value: ev,
      label: ev
    } as OptionItem));

    el.valueHtmlAttributes = { size: null as any };
    el.onChange = onRedraw;
    if (ctx.value.value != ChartClient.defaultParameterValue(scriptParameter, token))
      el.labelHtmlAttributes = { style: { fontWeight: "bold" } };
    return <EnumLine {...el} />;
  }
  else if (scriptParameter.type == "Scala") {

    return <Scala ctx={ctx} chart={chart} scriptParameter={scriptParameter} onRedraw={onRedraw} />;
  }
  else {
    throw new Error("Unexpected Type = " + scriptParameter.type);
  }
}

export function Scala(p: { ctx: TypeContext<ChartParameterEmbedded>, scriptParameter: ChartClient.ChartScriptParameter, onRedraw?: () => void, chart: IChartBase }): React.ReactElement {


  const { ctx, scriptParameter, onRedraw, chart } = p;

  const token = scriptParameter.columnIndex == undefined ? undefined :
    chart.columns[scriptParameter.columnIndex].token?.token;

  const scala = p.scriptParameter.valueDefinition as ChartClient.Scala;

  const compatible = Object.entries(scala.standardScalas).filter(([value, columnType]) => columnType == undefined || token == undefined || ChartClient.isChartColumnType(token, columnType))
    .map(([value, columnType]) => value);

  const format = toNumberFormat(token?.format ?? undefined);

  function numberLine(part: string | null | undefined, buildPart: (newNumber: number | null) => string, label: string) {

    return <FormGroup label={label} ctx={ctx}>{id => <div className={p.ctx.inputGroupClass}>
      <NumberBox formControlClass={p.ctx.formControlClass} value={part ? (parseFloat(part) ?? null) : null}
        format={format}
        validateKey={isDecimalKey}
        onChange={newValue => {
          ctx.value.value = buildPart(newValue == null ? null : Number(newValue));
          p.onRedraw?.();
        }}
      />
      {token?.unit && <span className={p.ctx.readonlyAsPlainText ? undefined : "input-group-text"}>{token?.unit}</span>}
    </div>
    }</FormGroup>;
  }

  const value = ctx.value.value?.includes("...") ? "Custom" : (ctx.value.value ?? undefined);

  return (
    <div>
      <FormGroup ctx={ctx} label={scriptParameter.displayName}
        labelHtmlAttributes={{ style: { fontWeight: ctx.value.value != ChartClient.defaultParameterValue(scriptParameter, token) ? "bold" : undefined } }}>
        {id => <select id={id} className={p.ctx.formSelectClass} value={value}
          onChange={o => {
            ctx.value.value = o.currentTarget.value == "Custom" ? "0...100" : o.currentTarget.value;
            p.onRedraw?.();
          }}>
          {compatible.map(a => <option key={a}>{a}</option>)}
          {scala.custom && <option>Custom</option>}
        </select>
        }
      </FormGroup>

      {ctx.value.value?.includes("...") && < div className="row">
        <div className="col-sm-6">
          {numberLine(ctx.value.value.before("..."), newValue => (newValue?.toString() ?? "") + "..." + ctx.value.value!.after("..."), "Min " + (token?.niceName() ?? ""))}
        </div>
        <div className="col-sm-6">
          {numberLine(ctx.value.value.after("..."), newValue => ctx.value.value!.before("...") + "..." + (newValue?.toString() ?? ""), "Max " + (token?.niceName() ?? ""))}
        </div>
      </div>
      }

    </div>
  );
}
