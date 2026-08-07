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
// to the right editor and collapses Signum's Value/String/Enum/Embedded/Model/Lite rules.
// Only the rules needing a DIFFERENT control stay distinct: low-population lites → combo, date pairs →
// DateTimeRange, scalar list ops → repeatable editor, entity (Lite) list ops → EntityStrip (MultiEntity),
// filter groups → search box.
import * as React from "react";
import { Finder } from "./Finder";
import EntityLink from "./SearchControl/EntityLink";
import type { Lite } from "../data/lite";
import type { Entity } from "../data/entity";
import type { FilterOptionParsed, FilterConditionOptionParsed, FilterGroupOptionParsed, FindOptions } from "./FindOptions";
import { isFilterCondition, isFilterGroup, isList, isPair, getFilterOperations } from "./FindOptions";
import { TypeReference } from "../data/reflection";
import type { FilterOperation } from "../data/dynamicQueries";
import type { QueryToken } from "./QueryToken";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { TypeContext } from "./TypeContext";
import { cellHighlighter } from "./searchHighlight";
import { tokenSequence } from "./QueryTokenString";
import { Binding } from "./binding";
import { AutoLine } from "./Lines/AutoLine";
import { EntityLine } from "./Lines/EntityLine";
import { EntityCombo } from "./Lines/EntityCombo";
import { EntityStrip } from "./Lines/EntityStrip";
import { DateTimeRange } from "./Lines/DateTimeRange";
import { FormGroup } from "./Lines/FormGroup";
import { EntityBaseController } from "./Lines/EntityBase";
import { LinkButton } from "./Basics/LinkButton";
import { useForceUpdate } from "./Hooks";
import { Enum } from "../data/enum";
import { TelephoneValidator, EmailValidator } from "../data/validators";
import { Temporal } from "../data/basics";
import { toNumberFormat } from "./numberFormat";
import { SearchMessage, JavascriptMessage } from "../data/uiMessages";

// Render any result-cell value as text: a Lite/entity/Temporal/Decimal shows its toString() (a wire lite
// via its `toStr`), a plain value via String().
function cellToStr(cell: any): string {
  if (cell == null) return "";
  if (typeof cell === "object") return (cell.toStr as string | undefined) ?? (typeof cell.toString === "function" ? cell.toString() : "");
  return String(cell);
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
      formatter: (qt, sc) => {
        const hl = cellHighlighter(qt, sc);
        return new Finder.CellFormatter(cell => cell == null ? "" : <span className="try-no-wrap">{hl.highlight(cellToStr(cell))}</span>, false);
      },
    },
    // Embedded / Model entity: its toString (Signum's "Entity").
    {
      name: "Entity",
      isApplicable: qt => qt.filterType == "Embedded" || qt.filterType == "Model",
      formatter: () => new Finder.CellFormatter(cell => cell == null ? "" : <span className="try-no-wrap">{cellToStr(cell)}</span>, true),
    },
    // Multi-line string (member.isMultiline): rendered in a wrapping block (Signum's "MultiLine"), with
    // the matched search keywords highlighted.
    {
      name: "MultiLine",
      isApplicable: qt => qt.filterType == "String" && qt.getPropertyRoute()?.fieldInfo?.isMultiline == true,
      formatter: (qt, sc) => {
        const hl = cellHighlighter(qt, sc);
        return new Finder.CellFormatter(cell => cell == null ? "" : <span className="multi-line">{hl.highlight(cellToStr(cell))}</span>, true);
      },
    },
    // Telephone string (field carries a @telephoneValidator): comma-separated numbers rendered as tel:
    // links (Signum's "Phone", which keys off MemberInfo.IsPhone — derived there from the same validator),
    // with matched search keywords highlighted inside each number.
    {
      name: "Phone",
      isApplicable: qt => qt.filterType == "String" && (qt.getPropertyRoute()?.fieldInfo?.validators.some(v => v instanceof TelephoneValidator) ?? false),
      formatter: (qt, sc) => {
        const multiLineClass = qt.getPropertyRoute()?.fieldInfo?.isMultiline ? "multi-line" : "try-no-wrap";
        const hl = cellHighlighter(qt, sc);
        return new Finder.CellFormatter((cell: string | undefined) => {
          if (!cell) return "";
          const parts = cell.split(",").map(t => t.trim());
          return (
            <span className={multiLineClass}>
              {parts.map((t, i) => <React.Fragment key={i}>{i > 0 ? ", " : null}<a href={`tel:${t}`}>{hl.highlight(t)}</a></React.Fragment>)}
            </span>
          );
        }, false, "telephone-link-cell");
      },
    },
    // E-mail string (field carries a @emailValidator): rendered as a mailto: link (Signum's "Email"), with
    // matched search keywords highlighted.
    {
      name: "Email",
      isApplicable: qt => qt.filterType == "String" && (qt.getPropertyRoute()?.fieldInfo?.validators.some(v => v instanceof EmailValidator) ?? false),
      formatter: (qt, sc) => {
        const multiLineClass = qt.getPropertyRoute()?.fieldInfo?.isMultiline ? "multi-line" : "try-no-wrap";
        const hl = cellHighlighter(qt, sc);
        return new Finder.CellFormatter((cell: string | undefined) =>
          !cell ? "" : <span className={multiLineClass}><a href={`mailto:${cell}`}>{hl.highlight(cell)}</a></span>, false, "email-link-cell");
      },
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
          try { return <span className="try-no-wrap">{numberFormat.format(Number(cell))}</span>; }
          catch { return <span className="try-no-wrap">{String(cell)}</span>; }
        }, false, "numeric-cell");
      },
    },
    // Decimal: right-aligned, `column.format` applied via Intl (Signum's "Decimal"). A Decimal-typed
    // cell arrives as a decimal.js Decimal (or its numeric string) — Number() coerces either for display.
    {
      name: "Decimal",
      isApplicable: qt => qt.filterType == "Decimal",
      formatter: (qt, sc, opts) => {
        const numberFormat = toNumberFormat(opts?.format ?? qt.format);
        return new Finder.CellFormatter((cell: any) => {
          if (cell == null) return "";
          try { return <span className="try-no-wrap">{numberFormat.format(Number(cell))}</span>; }
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
          try { str = numberFormat.format(Number(cell)); }
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
    // Lite / entity reference: an EntityLink to the entity's view route (Signum's "Lite" rule). Renders
    // the lite's display via Navigator.renderLite; `shy` dims it, `inSearch="related"` picks the search
    // viewability rule, and onNavigated refreshes the row after a modal view.
    {
      name: "Lite",
      isApplicable: qt => qt.filterType == "Lite",
      formatter: () => new Finder.CellFormatter((cell: Lite<Entity> | undefined, ctx) =>
        cell == null ? "" : <EntityLink lite={cell} onNavigated={ctx.refresh} inSearch="related" shy />, true),
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
    //   • "Object" keyword highlighting + "Snippet"/"SmallText" — need the search keyword infra
    //     (getKeywords/similarToken/findFilterValue in Search.tsx + TextHighlighter wiring). Plain text is
    //     rendered by "Default"/"MultiLine" in the meantime. ("Phone"/"Email" ARE ported above, minus the
    //     keyword highlighting — detected by scanning the field's validators for Telephone/Email, since
    //     altea has no MemberInfo.IsPhone/IsMail flag like Signum's ReflectionServer.)
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
    // Default row-entity rendering: an EntityLink wrapping the view icon (Signum's "View" rule). Hidden
    // when the entity isn't viewable; onNavigated refreshes the search after a modal view.
    {
      name: "View",
      isApplicable: () => true,
      formatter: new Finder.EntityFormatter(ctx => {
        const lite = ctx.row.entity;
        if (lite == null)
          return "";
        return (
          <EntityLink lite={lite} inSearch="main" hideIfNotViewable onNavigated={ctx.searchControl?.handleOnNavigated}
            className="sf-line-button sf-view">
            <span title={SearchMessage.View.niceToString()}>{EntityBaseController.getViewIcon()}</span>
          </EntityLink>
        );
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

// ---- Domain-restricted filter-value pickers (Signum's getDomainFindOptions) ----
// A Lite/entity filter-value picker can be DOMAIN-restricted: when the query ALREADY filters an ancestor
// entity's domain field to a value, the picker only offers entities whose OWN domain field matches. E.g.
// with `Finder.registerDomainForTokens(NeighborhoodEntity, n => n.city)`, a Neighborhood filter is
// restricted to the City already filtered elsewhere in the same query. Dormant until an app registers a
// domain (eastwind registers none yet), but kept faithful to Signum so it lights up when one does.
//
// altea divergences from Signum's getDomainFindOptions:
//   - no QueryDescription: walk the token.parent chain + the query root (ffc.queryToken) instead;
//   - no findFilterValue / similarToken port: match filters by fullKey() string;
//   - ROOTLESS token keys: the picked entity's domain field is "City" (via type.token(getDomainField)),
//     NOT Signum's "Entity.City" — same divergence as the autocomplete token keys;
//   - liteKey(l) → l.key().
function domainFindOptions(filterToken: QueryToken, ffc: Finder.FilterFormatterContext): FindOptions | undefined {
  const typeName = filterToken.type.getTypeName();
  if (typeName == null || !Finder.domainRegistry.has(typeName))
    return undefined; // not a registered domain type → no restriction (picker searches all)

  const entry = Finder.domainRegistry.get(typeName)!;

  const allDomains: Lite<Entity>[] = [];
  for (const parent of findParentTokensInRegistry(filterToken, ffc.queryToken)) {
    const parentEntry = Finder.domainRegistry.get(parent.typeName)!;
    // altea: Type<T> is a bare ctor (no `.token` static), so build the field token string directly via
    // tokenSequence — exactly what Type.token(lambda) calls internally.
    const fieldKey = tokenSequence(parentEntry.getDomainField, true);
    const parentDomainKey = parent.tokenKey === "" ? fieldKey : parent.tokenKey + "." + fieldKey;
    const val = findFilterValue(ffc.filterOptions, parentDomainKey, op => op == "EqualTo" || op == "IsIn");
    if (val != null)
      Array.isArray(val) ? allDomains.push(...val) : allDomains.push(val);
  }

  if (allDomains.length == 0)
    return undefined;

  const distinctDomains = allDomains.distinctBy(l => l.key());

  return {
    queryName: entry.type,
    filterOptions: [{
      token: tokenSequence(entry.getDomainField, true), // rootless: the picked entity's own domain field
      operation: distinctDomains.length > 1 ? "IsIn" : "EqualTo",
      value: distinctDomains.length > 1 ? distinctDomains : distinctDomains[0],
    }],
  };
}

// Ancestor tokens (the filter token's parent chain, skipping collections) plus the query ROOT entity,
// whose type is itself a registered domain type. `tokenKey` is the rootless fullKey ("" for the root).
function findParentTokensInRegistry(filterToken: QueryToken, root: QueryToken): { tokenKey: string; typeName: string }[] {
  const result: { tokenKey: string; typeName: string }[] = [];
  for (let p = filterToken.parent; p != null; p = p.parent) {
    if (p.type.array)
      continue;
    const tn = p.type.getTypeName();
    if (tn != null && Finder.domainRegistry.has(tn))
      result.push({ tokenKey: p.fullKey(), typeName: tn });
  }
  const rootTn = root.type.getTypeName();
  if (rootTn != null && Finder.domainRegistry.has(rootTn) && !result.some(r => r.typeName == rootTn))
    result.push({ tokenKey: root.fullKey(), typeName: rootTn });
  return result;
}

// Signum's findFilterValue (Search.tsx, not ported): the value of the first active filter CONDITION whose
// token matches `tokenKey` (by rootless fullKey) and whose operation satisfies `opFilter`; recurses groups.
function findFilterValue(filters: FilterOptionParsed[], tokenKey: string, opFilter: (op: FilterOperation) => boolean): any {
  for (const f of filters) {
    if (isFilterGroup(f)) {
      const v = findFilterValue(f.filters, tokenKey, opFilter);
      if (v != null)
        return v;
    } else if (f.token?.fullKey() == tokenKey && f.operation != null && opFilter(f.operation) && f.value != null) {
      return f.value;
    }
  }
  return undefined;
}

// Port of Signum's `getFilterGroupUnifiedFilterType` (FindOptions.ts): the broad category a value type
// falls into when deciding whether a filter group's subfilters can share ONE value editor. Numbers,
// boolean, string and Guid all collapse to "String" (a free-text box searches them all), so the default
// id+text group counts as unified even though its token types differ. Returns the typeName for anything
// not otherwise categorised (embedded/other), so distinct categories stay distinct.
function filterGroupUnifiedCategory(tr: TypeReference): string {
  const n = tr.typeName;
  if (n == "Number" || n == "Decimal" || n == "Boolean" || n == "String" || n == "Guid")
    return "String";
  if (n == "PlainDate" || n == "PlainDateTime")
    return "DateTime";
  if (n == "PlainTime" || n == "Duration")
    return "Time";
  if (tr.getEnum())
    return "Enum";
  if (tr.lite || tr.typeInfos().length > 0)
    return "Lite";
  return n;
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
    // Single-value entity/Lite: an EntityLine with create={false} — a filter picks an EXISTING value, it
    // never creates one — and domain-restricted findOptions (see getDomainFindOptions) when the picked
    // type is registered. Signum's dedicated "Lite" rule (altea otherwise collapses single values into
    // "Value" via AutoLine, but this rule wins for Lite tokens because it is declared AFTER "Value" and
    // `renderFilterValue` picks the LAST applicable). Declared BEFORE "Lite_LowPopulation" so the
    // low-population combo overrides it in turn.
    {
      name: "Lite",
      applicable: (f, ffc) => isFilterCondition(f) && f.token?.filterType == "Lite" && !(f.operation != null && isList(f.operation)),
      renderValue: (f, ffc) =>
        <EntityLine ctx={ffc.ctx} create={false} findOptions={domainFindOptions(f.token!, ffc)}
          onChange={() => ffc.handleValueChange(f)} label={ffc.label} mandatory={ffc.mandatory} />,
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
        <EntityCombo ctx={ffc.ctx} create={false} onChange={() => ffc.handleValueChange(f)} label={ffc.label} mandatory={ffc.mandatory} />,
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
    // List operations on a Lite token (IsIn / IsNotIn over entities): an EntityStrip bound DIRECTLY to
    // the Lite<T>[] filter value (Signum's dedicated "MultiEntity" rule). altea has no MList, so the
    // strip runs its direct-value-array mode — each array element IS the picked Lite (no wrapping row /
    // @valueField). create={false}: a filter picks existing entities. More specific than "MultiValue"
    // and declared AFTER it, so `renderFilterValue`'s `.last(applicable)` selects this for lite lists.
    {
      name: "MultiEntity",
      applicable: (f, ffc) => isFilterCondition(f) && f.token != null && f.operation != null && isList(f.operation) && f.token.filterType == "Lite",
      renderValue: (f, ffc) => {
        if (!Array.isArray((f as FilterConditionOptionParsed).value))
          (f as FilterConditionOptionParsed).value = [];
        return <EntityStrip ctx={ffc.ctx} create={false} findOptions={domainFindOptions(f.token!, ffc)}
          onChange={() => ffc.handleValueChange(f)} label={ffc.label} />;
      },
    },
    // Filter group: a single value searched across the group's conditions (Signum's "FilterGroup" rule).
    // ALWAYS renders an editor — mirroring Signum's `AutoLine type={tr ?? { name: "string" }}` / TextBoxLine
    // fallback. altea's Lines read the value type from ctx.memberType (no `type` prop) and a group ctx has
    // no token type, so we compute the unified editor type here and stamp it onto the ctx:
    //   • any sub-group or tokenless condition → a free-text (String) search box;
    //   • all subfilters share ONE type name → that type (e.g. an all-DateTime group → a date editor);
    //   • otherwise → String (the default id+text search: ToString is String, Id is Number/Guid → mixed).
    // The fallback String is nullable: a group value is always optional, so clearing it must not trip the
    // mandatory check in LineBase.defaultResetValidationError (which calls ctx.niceName() on this route-less
    // ctx and would throw "No propertyRoute").
    {
      name: "FilterGroup",
      applicable: (f, ffc) => isFilterGroup(f),
      renderValue: (f, ffc) => {
        const fg = f as FilterGroupOptionParsed;
        const label = ffc.label ?? SearchMessage.Search.niceToString();
        const stringTr = new TypeReference({ typeName: "String", isNullable: true });

        let tr: TypeReference;
        if (fg.filters.some(a => isFilterGroup(a) || !(a as FilterConditionOptionParsed).token)) {
          tr = stringTr;
        } else {
          const conds = fg.filters as FilterConditionOptionParsed[];
          const distinct = conds.map(a => a.token!.type).distinctBy(t => t.typeName);
          tr = distinct.length == 1 ? distinct[0] : stringTr;

          // Signum resets a stale value when the group's subfilters no longer share a unified filter-type
          // CATEGORY (numbers/bool/string/Guid all count as one "String" category — so the id+text search,
          // whose types differ but share that category, keeps its value).
          if (ffc.ctx.value != null && conds.map(a => filterGroupUnifiedCategory(a.token!.type)).distinctBy(c => c).length != 1)
            ffc.ctx.value = undefined;
        }

        ffc.ctx.typeReference = tr;
        return <AutoLine ctx={ffc.ctx} onChange={() => ffc.handleValueChange(f)} label={label} mandatory={ffc.mandatory} />;
      },
    },
    // NOT PORTED (Signum filter-value rules that need infrastructure altea lacks):
    //   • "String" override (TextBoxLine autoTrimString=false), "Enum" (explicit EnumLine), "Embedded"/
    //     "Model" (EntityLine) — COLLAPSED into "Value" above: altea's AutoLine already dispatches to the
    //     right editor from ctx.memberType, so separate rules would be redundant. ("Lite" IS kept separate
    //     above — it needs create={false} + domain findOptions that the generic AutoLine can't supply.)
    //   • "MultiEntity" — ported above as an EntityStrip over the Lite<T>[] value (direct-value-array
    //     mode); "MultiValue" now handles only NON-Lite list tokens (scalars) since MultiEntity wins for
    //     lites via `.last(applicable)`.
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
