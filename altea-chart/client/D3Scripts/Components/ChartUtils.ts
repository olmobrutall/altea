import * as d3 from "d3"
import type { ChartColumn } from "../../ChartClient"
import { isFilterGroup } from "@altea/altea/client/FindOptions";
import type { FilterConditionOptionParsed, FilterOptionParsed } from "@altea/altea/client/FindOptions";
import type { MemoRepository } from "./ReactChart";
import * as ColorUtils from "../../ColorPalette/ColorUtils"
// altea Array/String prototype extensions (.firstOrNull/.toObject/.after/…) — see ColorUtils.
import "@altea/altea/data/globals/arrayExtensions";
import "@altea/altea/data/globals/stringExtensions";

// Copy-and-fix of Signum.Chart/D3Scripts/Components/ChartUtils.ts. Fixes: @framework/* → altea; luxon
// removed (see completeValues / scaleFor notes); QueryToken.fullKey is a method in altea; ChartColumn.type
// is the string type name (Signum's client string-union ChartColumnType).
//
// altea divergence: completeValues' gap-filling for Enum / Number / Date columns (Signum synthesizes the
// missing buckets via luxon date math + enum reflection) is DEFERRED — the No / IsIn-filter / Entity /
// String paths are faithful, the rest returns the raw values (charts render without empty buckets). The
// Time branch of scaleFor parses "HH:mm:ss" with Date instead of luxon.

export function translate(x: number, y: number): string {
  if (y == undefined)
    return 'translate(' + x + ')';

  return 'translate(' + x + ',' + y + ')';
}

export function scale(x: number, y: number): string {
  if (y == undefined)
    return 'scale(' + x + ')';

  return 'scale(' + x + ',' + y + ')';
}

export function rotate(angle: number, x?: number, y?: number): string {
  if (x == undefined || y == undefined)
    return 'rotate(' + angle + ')';

  return 'rotate(' + angle + ',' + y + ',' + y + ')';
}

export function skewX(angle: number): string {
  return 'skewX(' + angle + ')';
}

export function skewY(angle: number): string {
  return 'skewY(' + angle + ')';
}

export function matrix(a: number, b: number, c: number, d: number, e: number, f: number): string {
  return 'matrix(' + a + ',' + b + ',' + c + ',' + d + ',' + e + ',' + f + ')';
}

export function scaleFor(column: ChartColumn<any>, values: number[], minRange: number, maxRange: number, scaleName: string | null | undefined):
  d3.ScaleContinuousNumeric<number, number> {

  if (scaleName?.includes("...")) {
    const minV = parseFloat(scaleName.before("..."));
    const maxV = parseFloat(scaleName.after("..."));

    return d3.scaleLinear()
      .domain([minV, maxV])
      .range([minRange, maxRange])
      .nice();
  }

  if (scaleName == "ZeroMax") {

    let max = d3.max(values)!;
    if (max == 0) // To keep the color or 0 stable
      max = 1;

    return d3.scaleLinear()
      .domain([0, max])
      .range([minRange, maxRange])
      .nice();

  }

  if (scaleName == "MinMax" || scaleName == "MinZeroMax") {
    if (column.type == "Date" || column.type == "DateTime") {
      var dates = values.map(d => new Date(d));

      const scale = d3.scaleTime()
        .domain([d3.min(dates)!, d3.max(dates)!])
        .range([minRange, maxRange]);

      const f = function (d: string | Date) { return scale(typeof d == "string" ? new Date(d) : d); } as any as d3.ScaleContinuousNumeric<number, number>;
      f.ticks = scale.ticks as any;
      f.tickFormat = scale.tickFormat as any;
      return f;
    }
    else if (column.type == "Time") {
      // altea: luxon DateTime.fromFormat("HH:mm:ss.u") → Date parse of an ISO time.
      var dates = values.map(d => new Date("1970-01-01T" + (d as any as string) + "Z"));

      const scale = d3.scaleTime()
        .domain([d3.min(dates)!, d3.max(dates)!])
        .range([minRange, maxRange]);

      const f = function (d: string | Date) { return scale(typeof d == "string" ? new Date("1970-01-01T" + d + "Z") : d); } as any as d3.ScaleContinuousNumeric<number, number>;
      f.ticks = scale.ticks as any;
      f.tickFormat = scale.tickFormat as any;
      return f;
    }
    else {
      return d3.scaleLinear()
        .domain([d3.min(values)!, d3.max(values)!])
        .range([minRange, maxRange])
        .nice();
    }
  }

  if (scaleName == "Log")
    return d3.scaleLog()
      .domain([d3.min(values)!, d3.max(values)!])
      .range([minRange, maxRange])
      .nice();

  if (scaleName == "Sqrt")
    return d3.scalePow().exponent(.5)
      .domain([d3.min(values)!, d3.max(values)!])
      .range([minRange, maxRange]);

  throw Error("Unexpected scale: " + scaleName);
}

export function insertPoint(keyColumn: ChartColumn<any>, valueColumn: ChartColumn<any>): "Middle" | "Before" | "After" {

  if (valueColumn.orderByIndex != null && (keyColumn.orderByIndex == null || valueColumn.orderByIndex < keyColumn.orderByIndex)) {
    if (valueColumn.orderByType == "Ascending")
      return "Before";
    else
      return "After";
  } else {
    return "Middle";
  }
}


export function completeValues(column: ChartColumn<unknown>, values: unknown[], completeValues: string | null | undefined, filterOptions: FilterOptionParsed[], insertPoint: "Middle" | "Before" | "After"): unknown[] {
  if (completeValues == null || completeValues == "No")
    return values;

  function withoutEntity(fullKey: string) {
    if (fullKey.startsWith("Entity."))
      return fullKey.after("Entity.");

    return fullKey;
  }

  const matchingFilters = column.token && (completeValues == "FromFilters" || completeValues == "Auto") ?
    (filterOptions.filter(f => !isFilterGroup(f)) as FilterConditionOptionParsed[])
      .filter(f => f.token && withoutEntity(f.token.fullKey()) == withoutEntity(column.token!.fullKey())) :
    [];

  if (completeValues == "FromFilters" && matchingFilters.length == 0)
    return values;

  const isInFilter = matchingFilters.firstOrNull(a => a.operation == "IsIn");

  if (isInFilter)
    return complete(values, isInFilter.value as unknown[], column, insertPoint);

  if (column.type == "Entity" || column.type == "String")
    return values;

  // TODO(altea): gap-fill completion for Enum / Number / Date / DateTime columns (Signum synthesizes the
  // missing buckets via luxon date arithmetic + enum reflection). Deferred — return the raw values.
  return values;
}

function complete(values: unknown[], allValues: unknown[], column: ChartColumn<unknown>, insertPoint: "Middle" | "Before" | "After"): any[] {

  if (insertPoint == "Middle") {

    const allValuesDic = allValues.toObject(column.getKey);

    const oldValues = values.filter(a => !allValuesDic.hasOwnProperty(column.getKey(a)));

    return [...column.orderByType == "Descending" ? allValues.reverse() : allValues, ...oldValues];
  }
  else {
    const valuesDic = values.toObject(column.getKey);

    const newValues = allValues.filter(a => !valuesDic.hasOwnProperty(column.getKey(a)));

    if (insertPoint == "Before")
      return [...newValues, ...values];
    else if (insertPoint == "After") //Descending
      return [...values, ...newValues];
  }

  throw new Error();
}

export function getStackOffset(curveName: string): ((series: d3.Series<any, any>[], order: Iterable<number>) => void) | undefined {
  switch (curveName) {
    case "zero": return d3.stackOffsetNone;
    case "expand": return d3.stackOffsetExpand;
    case "silhouette": return d3.stackOffsetSilhouette;
    case "wiggle": return d3.stackOffsetWiggle;
  }

  return undefined;
}



export function getStackOrder(schemeName: string): ((series: d3.Series<any, any>) => Iterable<number>) | undefined {
  switch (schemeName) {
    case "none": return d3.stackOrderNone;
    case "ascending": return d3.stackOrderAscending;
    case "descending": return d3.stackOrderDescending;
    case "insideOut": return d3.stackOrderInsideOut;
    case "reverse": return d3.stackOrderReverse;
  }

  return undefined;
}


export function getCurveByName(curveName: string): d3.CurveFactoryLineOnly | undefined {
  switch (curveName) {
    case "basis": return d3.curveBasis;
    case "bundle": return d3.curveBundle.beta(0.5);
    case "cardinal": return d3.curveCardinal;
    case "catmull-rom": return d3.curveCatmullRom;
    case "linear": return d3.curveLinear;
    case "monotone": return d3.curveMonotoneX;
    case "natural": return d3.curveNatural;
    case "step": return d3.curveStep;
    case "step-after": return d3.curveStepAfter;
    case "step-before": return d3.curveStepBefore;
  }

  return undefined;
}

export function colorCategory(parameters: { [name: string]: string }, domain: string[], memo: MemoRepository, memoKey?: string, deps?: []): d3.ScaleOrdinal<string, string> {

  var category = parameters["ColorCategory"];
  var categorySteps = parseInt(parameters["ColorCategorySteps"]);

  return memo.memo<d3.ScaleOrdinal<string, string>>(memoKey ?? "colorCategory", [category, categorySteps, ...(deps ?? [])], () => {

    var scheme = ColorUtils.colorSchemes[category];
    var scale = d3.scaleOrdinal(scheme);
    domain.forEach(a => scale(a));
    return scale;
  });
}

export function getColorInterpolation(interpolationName: string | undefined | null): ((value: number) => string) | undefined {

  return ColorUtils.getColorInterpolation(interpolationName);
}
