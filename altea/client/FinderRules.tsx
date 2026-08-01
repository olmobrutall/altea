// Ported from Signum.React/FinderRules.tsx — copy-and-fix. Signum keeps ALL of Finder's rule sets here —
// the result-cell formatters (initFormatRules), the row-entity formatters (initEntityFormatRules), the
// quick-filter rules (initQuickFilterRules) and the filter-value editors (initFilterValueFormatRules) —
// so Finder.tsx keeps only the rule TYPES/classes (FormatRule, CellFormatter, EntityFormatter, …) and
// imports the concrete rules from here. That split is what lets the filter-value editors render the UI
// Lines (AutoLine/EntityLine/…): the Lines import Finder, so defining the rules here (not in Finder.tsx)
// keeps Finder.tsx free of a self-referential Lines import. Finder imports this module for all four init
// functions, so `import { Finder }` alone wires everything up — no startup side-effect import needed.
//
// altea is lighter than Signum on purpose (its wire format differs — enums arrive as ordinals, lites as
// {$lite,id,toStr}, dates as ISO strings), so the cell formatters here are altea's set, not a 1:1 port of
// Signum's (which also has Guid/Color/Email/multiline/… rules). For the filter-value editors: Signum
// passed an explicit `type={token.type}` to every Line; altea's Lines read the type off `ctx.memberType`
// (FilterBuilder builds the value ctx already carrying `f.token.type`), so a single <AutoLine> dispatches
// to the right editor and collapses Signum's Value/String/Enum/Embedded/Model/Lite/MultiEntity rules.
// Only the rules needing a DIFFERENT control stay distinct: low-population lites → combo, date pairs →
// DateTimeRange, list ops → repeatable editor, filter groups → search box.
import * as React from "react";
import { Link } from "react-router";
import { Finder } from "./Finder";
import type { FilterOptionParsed, FilterConditionOptionParsed } from "./FindOptions";
import { isFilterCondition, isFilterGroup, isList, isPair, getFilterOperations } from "./FindOptions";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { TypeContext } from "./TypeContext";
import { Binding } from "./binding";
import { AutoLine } from "./Lines/AutoLine";
import { EntityCombo } from "./Lines/EntityCombo";
import { DateTimeRange } from "./Lines/DateTimeRange";
import { FormGroup } from "./Lines/FormGroup";
import { EntityBaseController } from "./Lines/EntityBase";
import { LinkButton } from "./Basics/LinkButton";
import { useForceUpdate } from "./Hooks";
import { Enum } from "../entities/enum";
import { Temporal } from "../entities/basics";
import { toNumberFormat } from "./numberFormat";
import { SearchMessage, JavascriptMessage } from "../entities/uiMessages";

// Render any result-cell value as text: a Lite/entity/Temporal/Decimal shows its toString() (a wire lite
// via its `toStr`), a plain value via String().
function cellToStr(cell: any): string {
  if (cell == null) return "";
  if (typeof cell === "object") return (cell.toStr as string | undefined) ?? (typeof cell.toString === "function" ? cell.toString() : "");
  return String(cell);
}

// The entity view-route path for a wire lite — "/view/<cleanType.firstLower>/<id>", matching
// Navigator.navigateRouteDefault, but built inline so this module doesn't import Navigator. Reads the
// clean type name from `$lite` (already stripped of "Entity" by the wire serializer); also tolerates an
// EntityType/entityType field (raw string or a Type object) and strips a trailing "Entity". Returns
// undefined when the type name or id is missing.
function liteViewPath(lite: any): string | undefined {
  if (lite == null) return undefined;
  const raw = lite.$lite ?? lite.EntityType ?? lite.entityType;
  const typeName: string | undefined = typeof raw === "string" ? raw : raw?.name;
  if (typeName == null || lite.id == null) return undefined;
  const clean = typeName.endsWith("Entity") ? typeName.substring(0, typeName.length - "Entity".length) : typeName;
  const lower = clean.charAt(0).toLowerCase() + clean.slice(1);
  return "/view/" + lower + "/" + lite.id;
}

// Result-cell formatters (Signum's FinderRules.initFormatRules — altea's adapted set). The LAST applicable
// rule wins (getCellFormatter uses .last), so "Default" is first and "Collection" is last.
//
// Wire value shapes (the client JSON.parses the ResultTable — no typed decode, see Services.ajaxPost):
//   numbers  → JS number      booleans → boolean      strings → string
//   enums    → the ORDINAL integer (e.g. OrderState "Shipped" → 3)
//   DateOnly/DateTime/Time → ISO string (PlainDate/PlainDateTime/PlainTime/Duration serialized as text)
//   Lite/entity ref → { $lite: cleanTypeName, id, toStr }   collections → array of the above
export function initFormatRules(): Finder.FormatRule[] {
  return [
    // Catch-all: any value as text (objects with a `toStr`, e.g. a lite, via that). Loses to every more
    // specific rule below because it is first and the last applicable rule wins.
    {
      name: "Default",
      isApplicable: () => true,
      formatter: () => new Finder.CellFormatter(cell => cellToStr(cell), false),
    },
    // Embedded / Model entity: its toString (Signum's "Entity").
    {
      name: "Entity",
      isApplicable: qt => qt.filterType == "Embedded" || qt.filterType == "Model",
      formatter: () => new Finder.CellFormatter(cell => cell == null ? "" : <span className="try-no-wrap">{cellToStr(cell)}</span>, true),
    },
    // Multi-line string (member.isMultiline): rendered in a wrapping block (Signum's "MultiLine"; the
    // keyword-highlight variant is dropped — needs the getKeywords/TextHighlighter search infra).
    {
      name: "MultiLine",
      isApplicable: qt => qt.filterType == "String" && qt.getPropertyRoute()?.fieldInfo?.isMultiline == true,
      formatter: () => new Finder.CellFormatter(cell => cell == null ? "" : <span className="multi-line">{cellToStr(cell)}</span>, true),
    },
    // Password column: masked dots (Signum's "Password").
    {
      name: "Password",
      isApplicable: qt => qt.format == "Password",
      formatter: () => new Finder.CellFormatter(cell => cell ? <span className="try-no-wrap">•••••••</span> : "", false),
    },
    // Guid: truncated "1234…cdef" (Signum's "Guid"; keyword bolding dropped).
    {
      name: "Guid",
      isApplicable: qt => qt.filterType == "Guid",
      formatter: () => new Finder.CellFormatter((cell: any) => {
        if (!cell) return "";
        const s = String(cell);
        return <span className="guid try-no-wrap">{s.substring(0, 4) + "…" + s.substring(s.length - 4)}</span>;
      }, false),
    },
    // Integer: right-aligned, `column.format` applied via Intl (Signum's "Integer", minus keyword bolding).
    {
      name: "Integer",
      isApplicable: qt => qt.filterType == "Integer",
      formatter: (qt, sc, opts) => {
        const numberFormat = toNumberFormat(opts?.format ?? qt.format);
        return new Finder.CellFormatter((cell: any) => {
          if (cell == null) return "";
          try { return <span className="try-no-wrap">{numberFormat.format(cell)}</span>; }
          catch { return <span className="try-no-wrap">{String(cell)}</span>; }
        }, false, "numeric-cell");
      },
    },
    // Decimal: right-aligned, `column.format` applied via Intl (Signum's "Decimal").
    {
      name: "Decimal",
      isApplicable: qt => qt.filterType == "Decimal",
      formatter: (qt, sc, opts) => {
        const numberFormat = toNumberFormat(opts?.format ?? qt.format);
        return new Finder.CellFormatter((cell: any) => {
          if (cell == null) return "";
          try { return <span className="try-no-wrap">{numberFormat.format(cell)}</span>; }
          catch { return <span className="try-no-wrap">{String(cell)}</span>; }
        }, false, "numeric-cell");
      },
    },
    // Number with Unit: appends the column/opts unit after the formatted number (Signum's "Number with
    // Unit"). Placed after Integer/Decimal so it wins (via .last) when a unit is present.
    {
      name: "Number with Unit",
      isApplicable: (qt, sc, opts) => (qt.filterType == "Integer" || qt.filterType == "Decimal") && Boolean(opts?.unit !== undefined ? opts.unit : qt.unit),
      formatter: (qt, sc, opts) => {
        const numberFormat = toNumberFormat(opts?.format ?? qt.format);
        const unit = opts?.unit !== undefined ? opts.unit : qt.unit;
        return new Finder.CellFormatter((cell: any) => {
          if (cell == null) return "";
          let str: string;
          try { str = numberFormat.format(cell); }
          catch { str = String(cell); }
          return <span className="try-no-wrap">{str + " " + unit}</span>;
        }, false, "numeric-cell");
      },
    },
    // Enum: the cell is the ORDINAL integer — Enum.niceName maps ordinal → member name → localized nice
    // name (falling back to a humanized member name).
    {
      name: "Enum",
      isApplicable: qt => qt.filterType == "Enum",
      formatter: qt => {
        const en = qt.type.getEnum();
        return new Finder.CellFormatter((cell: any) => {
          if (cell == null)
            return "";
          if (en == null)
            return String(cell);
          try { return <span className="try-no-wrap">{Enum.niceName(en as Record<string, string | number>, cell)}</span>; }
          catch { return String(cell); }
        }, false);
      },
    },
    // Boolean: a centered, disabled checkbox reflecting the value.
    {
      name: "Boolean",
      isApplicable: qt => qt.filterType == "Boolean",
      formatter: () => new Finder.CellFormatter((cell: any) => cell == null ? "" : <input type="checkbox" className="form-check-input" disabled={true} readOnly checked={Boolean(cell)} />, false, "centered-cell"),
    },
    // DateOnly / DateTime (filterType "DateTime"): parse the ISO string with the matching Temporal type
    // (keyed by `column.type.typeName`) and render its localized form; on a parse error fall back to the
    // raw string. `<bdi>` avoids flipping the hour/date order in RTL cultures (Signum's "DateTime").
    {
      name: "DateTime",
      isApplicable: qt => qt.filterType == "DateTime",
      formatter: qt => {
        const tn = qt.type.typeName;
        return new Finder.CellFormatter((cell: any) => {
          if (cell == null || cell === "")
            return "";
          const s = String(cell);
          try {
            if (tn == "PlainDate")
              return <bdi className="date try-no-wrap">{Temporal.PlainDate.from(s).toLocaleString()}</bdi>;
            if (tn == "PlainDateTime")
              return <bdi className="date try-no-wrap">{Temporal.PlainDateTime.from(s).toLocaleString()}</bdi>;
          }
          catch { return s; }
          return s;
        }, false, "date-cell");
      },
    },
    // Time (filterType "Time"): PlainTime / Duration (Signum's "Time").
    {
      name: "Time",
      isApplicable: qt => qt.filterType == "Time",
      formatter: qt => {
        const tn = qt.type.typeName;
        return new Finder.CellFormatter((cell: any) => {
          if (cell == null || cell === "")
            return "";
          const s = String(cell);
          try {
            if (tn == "PlainTime")
              return <bdi className="date try-no-wrap">{Temporal.PlainTime.from(s).toLocaleString()}</bdi>;
            if (tn == "Duration")
              return <bdi className="date try-no-wrap">{Temporal.Duration.from(s).toString()}</bdi>;
          }
          catch { return s; }
          return s;
        }, false, "date-cell");
      },
    },
    // Lite / entity reference: a react-router Link to the entity view route, built directly from the lite.
    // Link text is the lite's toStr; null → "".
    {
      name: "Lite",
      isApplicable: qt => qt.filterType == "Lite",
      formatter: () => new Finder.CellFormatter((cell: any) => {
        if (cell == null)
          return "";
        const path = liteViewPath(cell);
        const text = cellToStr(cell);
        return path == null ? <span className="try-no-wrap">{text}</span> : <Link to={path} className="try-no-wrap">{text}</Link>;
      }, true),
    },
    // Collection/array: join the elements' toStr (never "[object Object]"). Last rule, so an array of
    // numbers/enums/lites lands here rather than in the by-element rules above.
    {
      name: "Collection",
      isApplicable: qt => qt.type.array === true,
      formatter: () => new Finder.CellFormatter((cell: any) => {
        if (cell == null)
          return "";
        if (!Array.isArray(cell))
          return cellToStr(cell);
        return cell.map(x => cellToStr(x)).join(", ");
      }, false),
    },
    // NOT PORTED (Signum rules that depend on infrastructure altea doesn't have yet — kept here as a
    // checklist rather than silently dropped):
    //   • "Object" keyword highlighting + "Snippet"/"SmallText"/"Phone"/"Email" — need the search
    //     keyword infra (getKeywords/similarToken/findFilterValue in Search.tsx + TextHighlighter wiring)
    //     and, for Phone/Email, FieldInfo.isPhone/isMail flags (absent — altea FieldInfo has no such
    //     member metadata). Plain text is rendered by "Default"/"MultiLine" in the meantime.
    //   • "LiteNoFill" (Navigator.getSettings(ti).avoidFillSearchColumnWidth → non-filling Lite cell) —
    //     easy to add once desired; skipped to avoid a Navigator import here for a width-only tweak.
    //   • "TimeSeries" — needs the QueryTokenString.timeSeries token + systemTime.timeSeriesUnit plumbing.
    //   • "SystemValidFrom"/"SystemValidTo" — need the per-cell ctx.systemTime (mode/startDate/endDate) to
    //     be populated in getCellFormatter's CellFormatterContext (currently not threaded through).
  ];
}

// Row-entity formatters (Signum's FinderRules.initEntityFormatRules).
export function initEntityFormatRules(): Finder.EntityFormatRule[] {
  return [
    // Default row-entity rendering: a view Link (same as the Lite cell rule) for `ctx.row.entity`.
    {
      name: "View",
      isApplicable: () => true,
      formatter: new Finder.EntityFormatter(ctx => {
        const lite = ctx.row.entity as any;
        if (lite == null)
          return "";
        const path = liteViewPath(lite);
        const text = cellToStr(lite);
        return path == null ? <span className="try-no-wrap">{text}</span> : <Link to={path} className="try-no-wrap">{text}</Link>;
      }, "centered-cell"),
    },
    // Grouped results: the row is a group, so the "view" button opens the group's rows instead of an
    // entity (Signum's second "View" rule). Wins over the plain View via .last when groupResults is on.
    {
      name: "GroupView",
      isApplicable: sc => sc?.state.resultFindOptions?.groupResults == true,
      formatter: new Finder.EntityFormatter(ctx => {
        const sc = ctx.searchControl;
        return (
          <LinkButton title={JavascriptMessage.ShowGroup.niceToString()} className="sf-line-button sf-view"
            onClick={e => sc?.openRowGroup(ctx.row, e)}>
            <FontAwesomeIcon aria-hidden={true} icon="layer-group" />
          </LinkButton>
        );
      }, "centered-cell"),
    },
  ];
}

// Quick-filter rules (Signum's FinderRules.initQuickFilterRules): given a clicked cell, add the matching
// filter. The LAST applicable rule wins (getQuickFilterRule uses .last), so "Default" is first.
export function initQuickFilterRules(): Finder.QuickFilterRule[] {
  return [
    // Default: filter by the token's first operation and the cell value.
    {
      name: "Default",
      applicable: () => true,
      execute: async (qt, cellValue, sc) => sc.addQuickFilter(qt, getFilterOperations(qt).first(), cellValue),
    },
    // preferEquals tokens (id / lite / enum) default to EqualTo.
    {
      name: "PreferEquals",
      applicable: qt => Boolean(qt.preferEquals),
      execute: async (qt, cellValue, sc) => sc.addQuickFilter(qt, "EqualTo", cellValue),
    },
    // Model / Embedded: can't filter by value, only by presence — EqualTo null (has none) / DistinctTo null.
    {
      name: "Model",
      applicable: qt => qt.filterType == "Model",
      execute: async (qt, cellValue, sc) => sc.addQuickFilter(qt, cellValue == null ? "EqualTo" : "DistinctTo", null),
    },
    {
      name: "Embedded",
      applicable: qt => qt.filterType == "Embedded",
      execute: async (qt, cellValue, sc) => sc.addQuickFilter(qt, cellValue == null ? "EqualTo" : "DistinctTo", null),
    },
    // ToArray column: re-point the token to the collection's "Any" element and IsIn the array value.
    {
      name: "ToArray",
      applicable: qt => qt.hasToArray() != null,
      execute: async (qt, cellValue, sc) => {
        const toArray = qt.hasToArray()!;
        const newToken = await sc.parseSingleFilterToken(qt.fullKey().split(".").map(p => p == toArray.key ? "Any" : p).join("."));
        return sc.addQuickFilter(newToken, "IsIn", cellValue ?? []);
      },
    },
    // NOT PORTED: Signum's "Snippet" quick filter — needs the full-text Snippet token (absent in altea).
  ];
}

// A repeatable scalar-value editor for list operations (IsIn / IsNotIn). The filter value is a plain
// array (NOT altea's row-entity MList), so each element binds by array index to an AutoLine typed with
// the token's TypeReference — AutoLine then dispatches per item (so this also covers multi-entity: a
// Lite element renders an EntityLine). Add appends a null slot; remove drops the index.
function FilterMultiValue({ f, ffc }: { f: FilterConditionOptionParsed; ffc: Finder.FilterFormatterContext }): React.ReactElement {
  const forceUpdate = useForceUpdate();
  const tokenType = f.token!.type;
  const readOnly = ffc.ctx.readOnly;

  const array: any[] = Array.isArray(f.value) ? f.value : (f.value = []);

  return (
    <FormGroup ctx={ffc.ctx} label={ffc.label}>
      {() => (
        <div>
          {array.map((_, i) => {
            const ectx = new TypeContext<any>(ffc.ctx, { formGroupStyle: "None", readOnly }, tokenType, new Binding(array, i));
            return (
              <div key={i} className="d-flex align-items-center mb-1">
                <div className="flex-grow-1">
                  <AutoLine ctx={ectx} onChange={() => ffc.handleValueChange(f)} />
                </div>
                {!readOnly &&
                  <LinkButton className="sf-line-button sf-remove ms-1" title={SearchMessage.DeleteFilter.niceToString()}
                    onClick={() => { array.removeAt(i); ffc.handleValueChange(f); forceUpdate(); }}>
                    {EntityBaseController.getRemoveIcon()}
                  </LinkButton>}
              </div>
            );
          })}
          {!readOnly &&
            <LinkButton className="sf-line-button sf-create" title={SearchMessage.AddValue.niceToString()}
              onClick={() => { array.push(null); ffc.handleValueChange(f); forceUpdate(); }}>
              {EntityBaseController.getCreateIcon()}&nbsp;{SearchMessage.AddValue.niceToString()}
            </LinkButton>}
        </div>
      )}
    </FormGroup>
  );
}

export function initFilterValueFormatRules(): Finder.FilterValueFormatter[] {
  return [
    // Single value: AutoLine dispatches on the token type carried by ffc.ctx (Boolean/DateTime/Decimal/
    // Guid/Integer/Time/String/Enum/Lite/Embedded/Model).
    {
      name: "Value",
      applicable: (f, ffc) => isFilterCondition(f) && f.token != null && !(f.operation != null && isList(f.operation)),
      renderValue: (f, ffc) =>
        <AutoLine ctx={ffc.ctx} onChange={() => ffc.handleValueChange(f)} label={ffc.label} mandatory={ffc.mandatory} />,
    },
    // Low-population lite → a dropdown of all instances instead of the autocomplete line.
    {
      name: "Lite_LowPopulation",
      applicable: (f, ffc) => {
        if (!isFilterCondition(f) || f.token?.filterType != "Lite" || (f.operation != null && isList(f.operation)))
          return false;
        const tis = f.token.type.typeInfos();
        return tis.length > 0 && tis.every(ti => ti.lowPopulation == true);
      },
      renderValue: (f, ffc) =>
        <EntityCombo ctx={ffc.ctx} onChange={() => ffc.handleValueChange(f)} label={ffc.label} mandatory={ffc.mandatory} />,
    },
    // Date range: `Between` / `BetweenNoEnd` on a date column → two constrained DateTimeLines editing
    // f.value[0] / f.value[1], with the in-range days highlighted (Signum's DateRange rule).
    {
      name: "DateRange",
      applicable: (f, ffc) => isFilterCondition(f) && f.operation != null && isPair(f.operation) && f.token?.filterType == "DateTime",
      renderValue: (f, ffc) => {
        const fc = f as FilterConditionOptionParsed;
        if (!Array.isArray(fc.value))
          fc.value = [null, null];

        const tokenType = fc.token!.type;
        const minCtx = new TypeContext<string | null>(undefined, { readOnly: fc.frozen }, tokenType, new Binding<any>(fc.value, 0));
        const maxCtx = new TypeContext<string | null>(undefined, { readOnly: fc.frozen }, tokenType, new Binding<any>(fc.value, 1));

        return (
          <DateTimeRange
            mainCtx={ffc.ctx}
            label={ffc.label}
            min={{ ctx: minCtx, format: fc.token!.format, onChange: () => ffc.handleValueChange(f) }}
            max={{ ctx: maxCtx, format: fc.token!.format, onChange: () => ffc.handleValueChange(f) }}
          />
        );
      },
    },
    // List operations (IsIn / IsNotIn): a repeatable value editor over the array.
    {
      name: "MultiValue",
      applicable: (f, ffc) => isFilterCondition(f) && f.token != null && f.operation != null && isList(f.operation),
      renderValue: (f, ffc) => <FilterMultiValue f={f as FilterConditionOptionParsed} ffc={ffc} />,
    },
    // Filter group: a single value used to search across the group's conditions. Render the AutoLine when
    // the group has a unifying token type; otherwise nothing (no editable value).
    {
      name: "FilterGroup",
      applicable: (f, ffc) => isFilterGroup(f),
      renderValue: (f, ffc) =>
        ffc.ctx.memberType != null
          ? <AutoLine ctx={ffc.ctx} onChange={() => ffc.handleValueChange(f)} label={ffc.label} mandatory={ffc.mandatory} />
          : <span />,
    },
    // NOT PORTED (Signum filter-value rules that need infrastructure altea lacks):
    //   • "String" override (TextBoxLine autoTrimString=false), "Enum" (explicit EnumLine), "Embedded"/
    //     "Model"/"Lite" (EntityLine) — all COLLAPSED into "Value" above: altea's AutoLine already
    //     dispatches to the right editor from ctx.memberType, so separate rules would be redundant.
    //   • "MultiEntity" — COLLAPSED into "MultiValue": AutoLine renders an EntityLine per Lite element.
    //   • "Lite_IsByAll" / "Lite_TypeEntity" — need IsByAll handling + the TypeEntity query/cleanName
    //     filtering; altea has TypeEntity but not the SearchControl wiring these rules assume.
    //   • "TextArea" / "FilterGroup_TextArea" / "VectorSmartSearch" — full-text + vector search operations
    //     (isFullTextSearch / SmartSearch), which altea's query engine doesn't expose yet.
    //   • "FilterGroup_MultiValue" — multi-value editor across a group's unified type; the single
    //     "FilterGroup" rule above covers the common (single-value) group case.
  ];
}

// Finder.tsx wires initFilterValueFormatRules as its filterValueFormatRulesProvider (so `import Finder`
// pulls these editors in automatically, and resetFormatRules re-reads them). No self-registration here:
// Finder imports THIS module, so a top-level Finder.filterValueFormatRules mutation would run before
// Finder's own body has created that array.
