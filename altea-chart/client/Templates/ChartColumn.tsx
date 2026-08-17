import * as React from 'react'
import { classes } from '@altea/altea/data/globals/index'
import { TypeContext, StyleContext } from '@altea/altea/client/TypeContext'
import { TextBoxLine } from '@altea/altea/client/Lines/TextBoxLine'
import { FormGroup } from '@altea/altea/client/Lines/FormGroup'
import { ChartColumnEmbedded } from '../../data/ChartColumn'
import { ChartColumnType } from '../../data/ChartScriptColumn'
import { ChartMessage } from '../../data/ChartMessage'
import { ChartParameterEmbedded } from '../../data/ChartParameter'
import type { IChartBase } from '../../data/ChartRequest'
import { ChartClient } from '../ChartClient'
import { ColorPaletteClient } from '../ColorPalette/ColorPaletteClient'
import { ColorPaletteEntity } from '../../data/ColorPalette'
import { Navigator } from '@altea/altea/client/Navigator'
import { JavascriptMessage } from '@altea/altea/data/uiMessages'
import { cleanTypeName } from '@altea/altea/data/registration'
import { useForceUpdate, useAPIWithReload } from '@altea/altea/client/Hooks'
import { ColumnParameters } from './ChartBuilder'
import QueryTokenEmbeddedBuilder from '@altea/altea-user-assets/client/Templates/QueryTokenEmbeddedBuilder'
import { QueryToken, SubTokensOptions } from '@altea/altea/data/dynamicQuery/tokens/queryToken'
import { LinkButton } from '@altea/altea/client/Basics/LinkButton'
import '@altea/altea/data/globals/arrayExtensions'
import '@altea/altea/data/globals/stringExtensions'

// Copy-and-fix of Signum.Chart/Templates/ChartColumn.tsx (the token-editor row). altea divergences:
// @framework/* → altea; MList `.element` → plain arrays; no `.modified`; ChartColumnType is numeric (nice
// name via ChartClient.chartColumnTypeNiceName; expandGroup uses the numeric members); token.niceName() /
// .fullKey() are methods. The ColorPalette per-type links (getColorPalettes / ChartPaletteLink) show a
// "Colors for <Type>" View/Create-palette link for entity (Lite) columns — Signum's `!t.isLite &&
// !isTypeEnum` gate becomes `!t.lite` (altea's TypeReference.typeInfos() is [] for enums, a known gap).

export interface ChartColumnProps {
  ctx: TypeContext<ChartColumnEmbedded>;
  columnIndex: number;
  scriptColumn: ChartClient.ChartScriptColumn;
  chartScript: ChartClient.ChartScript;
  chartBase: IChartBase;
  queryKey: string;
  onRedraw: () => void;
  parameterDic: { [name: string]: TypeContext<ChartParameterEmbedded> },
  onOrderChanged: (chartColumn: ChartColumnEmbedded, e: React.MouseEvent<any>) => void;
  onTokenChange: () => void;
}


export function ChartColumn(p: ChartColumnProps): React.JSX.Element {

  const forceUpdate = useForceUpdate();

  const [expanded, setExpanded] = React.useState<boolean>(false);

  function handleExpanded() {
    setExpanded(!expanded);
  }

  function handleDragOver(de: React.DragEvent<any>) {
    de.preventDefault();
    var txt = de.dataTransfer.getData("text");
    const cols = p.chartBase.columns;
    if (txt.startsWith("chartColumn_")) {
      var dropIndex = cols.findIndex(a => a == p.ctx.value);
      var dragIndex = parseInt(txt.after("chartColumn_"));
      if (dropIndex == dragIndex)
        de.dataTransfer.dropEffect = "none";
    }
  }

  function handleOnDrop(de: React.DragEvent<any>) {
    de.preventDefault();

    const cols = p.chartBase.columns;
    var txt = de.dataTransfer.getData("text");
    if (txt.startsWith("chartColumn_")) {

      var dropIndex = cols.findIndex(a => a == p.ctx.value);
      var dragIndex = parseInt(txt.after("chartColumn_"));

      if (dropIndex != dragIndex) {

        var dropToken = cols[dropIndex].token;
        var dragToken = cols[dragIndex].token;
        cols[dropIndex].token = dragToken;
        cols[dragIndex].token = dropToken;

        p.onTokenChange();
      }

    }
  }

  function handleDragStart(de: React.DragEvent<any>) {
    const dragIndex = p.chartBase.columns.findIndex(a => a == p.ctx.value);
    de.dataTransfer.setData('text', "chartColumn_" + dragIndex); //cannot be empty string
    de.dataTransfer.effectAllowed = "move";
  }

  // Signum's getColorPalettes: the token's type → the palette target(s) so the expanded editor can offer a
  // "Colors for <Type>" View/Create-palette link (only when the ColorPalette entity is editable). Entity
  // (Lite) columns yield their TypeInfo(s); ENUM columns yield the enum type name directly (altea has no
  // client TypeInfo for enums — the server keys an enum palette's SpecificColors by member name).
  function getColorPalettes(): { cleanName: string; niceName: string }[] {
    const t = p.ctx.value.token?.token?.type;

    if (t == undefined || Navigator.isReadOnly(ColorPaletteEntity))
      return [];

    if (t.lite)
      return t.typeInfos().map(ti => ({ cleanName: cleanTypeName(ti.ctor!), niceName: ti.getNiceName() }));

    if (t.getEnum() != null) {
      const name = t.getTypeName();
      return name ? [{ cleanName: name, niceName: name }] : [];
    }

    return [];
  }

  function orderClassName(c: ChartColumnEmbedded) {
    if (c.orderByType == null || c.orderByIndex == null)
      return "";

    return (c.orderByType == "Ascending" ? "asc" : "desc") + (" l" + c.orderByIndex);
  }
  const sc = p.scriptColumn;

  var subTokenOptions = SubTokensOptions.CanElement | SubTokensOptions.CanAggregate | (p.chartBase.chartTimeSeries ? SubTokensOptions.CanTimeSeries : 0);

  const ctx = p.ctx;

  const ctxBasic = ctx.subCtx({ formSize: "xs", formGroupStyle: "Basic" });

  var numParameters = p.chartScript.parameterGroups.flatMap(a => a.parameters).filter(a => a.columnIndex == p.columnIndex).length

  return (
    <>
      <tr className="sf-chart-token">
        <th
          draggable={true}
          onDragEnter={handleDragOver}
          onDragOver={handleDragOver}
          onDrop={handleOnDrop}
          onDragStart={handleDragStart}

          onClick={e => ctx.value.token && p.onOrderChanged(ctx.value, e)}
          style={{ whiteSpace: "nowrap", cursor: ctx.value.token ? "pointer" : undefined, userSelect: "none" }}>
          <span className={"sf-header-sort " + orderClassName(ctx.value)} />
          {sc.displayName + (sc.isOptional ? "?" : "")}
        </th>
        <td>
          <div className={classes("sf-query-token")}>
            <QueryTokenEmbeddedBuilder
              ctx={ctx.subCtx(a => a.token, { formGroupStyle: "None" })}
              queryKey={p.queryKey}
              subTokenOptions={subTokenOptions} onTokenChanged={() => p.onTokenChange()} />
          </div>
          <span style={{
            color: ctx.value.token == null ? "#ddd" :
              ChartClient.isChartColumnType(ctx.value.token.token, sc.columnType) ? "#52b980" : "#ff7575",
            marginLeft: "10px",
            cursor: "default"
          }} title={getTitle(sc.columnType, ctx.value.token?.token ?? undefined)}>
            {ChartClient.chartColumnTypeNiceName(sc.columnType)}
          </span>
          <LinkButton
            title={undefined}
            className={classes("sf-chart-token-config-trigger", numParameters > 0 && ctx.value.token != null && "fw-bold")}
            onClick={handleExpanded}
            onKeyDown={e => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleExpanded();
              }
            }}>
            {ChartMessage.ToggleInfo.niceToString()} {numParameters > 0 && ctx.value.token && <span>({numParameters})</span>}
          </LinkButton>
        </td>
      </tr>
      {expanded && <tr className="sf-chart-token-config">
        <td></td>
        <td colSpan={1}>
          <div>
            <div className="row">
              <div className="col-sm-3">
                <TextBoxLine ctx={ctxBasic.subCtx(a => a.displayName)} valueHtmlAttributes={{ onBlur: p.onRedraw, placeholder: ctx.value.token?.token?.niceName() }} />
              </div>
              <div className="col-sm-3">
                <TextBoxLine ctx={ctxBasic.subCtx(a => a.format)} valueHtmlAttributes={{ onBlur: p.onRedraw, placeholder: ctx.value.token?.token?.format ?? undefined }} />
              </div>
              {getColorPalettes().map((t, i) =>
                <div className="col-sm-3" key={i}>
                  <ChartPaletteLink ctx={ctxBasic} cleanName={t.cleanName} niceName={t.niceName} refresh={forceUpdate} />
                </div>)
              }
            </div>
            <ColumnParameters chart={p.chartBase} chartScript={p.chartScript} columnIndex={p.columnIndex} parameterDic={p.parameterDic} onRedraw={p.onRedraw} />
          </div>
        </td>
      </tr>
      }
    </>
  );
}

function getTitle(ct: ChartColumnType, token: QueryToken | undefined): string {

  const group = expandGroup(ct);

  const tokenType = token && ChartClient.getChartColumnType(token);

  if (group != null)
    return ChartMessage.TheSelectedTokenShouldBeEither.niceToString() + "\n" +
      group.map(a => " - " + ChartClient.chartColumnTypeNiceName(a) + (a == tokenType ? " ✔" : "")).join("\n");


  return ChartMessage.TheSelectedTokenShouldBeA0.niceToString(ChartClient.chartColumnTypeNiceName(ct)) + (ct == tokenType ? " ✔" : "");

}


function expandGroup(ct: ChartColumnType): ChartColumnType[] | undefined {
  switch (ct) {
    case ChartColumnType.AnyGroupKey: return [ChartColumnType.String, ChartColumnType.Entity, ChartColumnType.Enum, ChartColumnType.Date, ChartColumnType.Number, ChartColumnType.RoundedNumber];
    case ChartColumnType.AnyNumber: return [ChartColumnType.Number, ChartColumnType.DecimalNumber, ChartColumnType.RoundedNumber];
    case ChartColumnType.AnyNumberDateTime: return [ChartColumnType.Number, ChartColumnType.DecimalNumber, ChartColumnType.RoundedNumber, ChartColumnType.Date, ChartColumnType.DateTime];
    default: return undefined;
  }
}

export interface ChartPaletteLinkProps {
  cleanName: string;
  niceName: string;
  refresh: () => void;
  ctx: StyleContext;
}

// Copy-and-fix of Signum's ChartPaletteLink — a "Colors for <Type>" link in the column editor that opens the
// type's ColorPalette (View if one exists, else Create a new palette pre-scoped to that type). altea: driven
// by a clean type-NAME (not a TypeInfo) so it covers enum columns too (which have no client TypeInfo.ctor —
// see getColorPalettes); the palette cache + Navigator.API.getType both key by that clean name.
export function ChartPaletteLink(p: ChartPaletteLinkProps): React.JSX.Element {

  const [palette, reload] = useAPIWithReload(() => ColorPaletteClient.getColorPalette(p.cleanName), [p.cleanName]);

  return (
    <FormGroup ctx={p.ctx} label={ChartMessage.ColorsFor0.niceToString(p.niceName)}>
      {() => palette === undefined ?
        <span className={p.ctx.formControlPlainTextClass}>
          {JavascriptMessage.loading.niceToString()}
        </span> :
        <LinkButton title={undefined} className={p.ctx.formControlPlainTextClass} onClick={async () => {
          if (palette)
            await Navigator.view(palette.lite);
          else {
            // Pre-scope the new palette to this column's type (Signum's Create branch): fetch the TypeEntity
            // for the clean name via Navigator.API.getType (backed by /api/reflection/typeEntity/:typeName).
            const t = await Navigator.API.getType(p.cleanName);
            const cp = ColorPaletteEntity.create({ type: t! });
            await Navigator.view(cp);
          }

          reload();
        }}>
          {palette ? ChartMessage.ViewPalette.niceToString() : ChartMessage.CreatePalette.niceToString()}
        </LinkButton>
      }
    </FormGroup>
  );
}
