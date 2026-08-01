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
import { isFilterCondition, isFilterGroup, isList, isPair } from "./FindOptions";
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
import { SearchMessage } from "../entities/uiMessages";

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
    // Number (Integer/Decimal): right-aligned, `column.format`/`column.unit` applied via Intl. Falls back
    // to String(cell) if the format throws.
    {
      name: "Number",
      isApplicable: qt => qt.filterType == "Integer" || qt.filterType == "Decimal",
      formatter: (qt, sc, opts) => {
        const numberFormat = toNumberFormat(opts?.format ?? qt.format);
        const unit = opts?.unit !== undefined && opts.unit !== null ? opts.unit : qt.unit;
        return new Finder.CellFormatter((cell: any) => {
          if (cell == null)
            return "";
          let str: string;
          try { str = numberFormat.format(cell); }
          catch { str = String(cell); }
          if (unit)
            str = str + " " + unit;
          return <span className="try-no-wrap">{str}</span>;
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
    // DateOnly / DateTime / Time: parse the ISO string with the matching Temporal type (keyed by
    // `column.type.typeName`) and render its localized form; on a parse error fall back to the raw string.
    {
      name: "DateTime",
      isApplicable: qt => qt.filterType == "DateTime" || qt.filterType == "Time",
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
  ];
}

// Quick-filter rules (Signum's FinderRules.initQuickFilterRules — not ported yet in altea).
export function initQuickFilterRules(): Finder.QuickFilterRule[] {
  return [];
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
  ];
}

// Finder.tsx wires initFilterValueFormatRules as its filterValueFormatRulesProvider (so `import Finder`
// pulls these editors in automatically, and resetFormatRules re-reads them). No self-registration here:
// Finder imports THIS module, so a top-level Finder.filterValueFormatRules mutation would run before
// Finder's own body has created that array.
