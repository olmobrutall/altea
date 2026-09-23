import * as React from "react";
import { Button } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconProp } from "@fortawesome/fontawesome-svg-core";
import { TypeContext } from "@altea/altea/client/TypeContext";
import type { IRenderButtons, IHasChanges, ButtonsContext, ButtonBarElement } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { Operations } from "@altea/altea/client/Operations";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import { tryGetTypeInfo } from "@altea/altea/client/Reflection";
import { classes } from "@altea/altea/data/globals";
import SelectorModal from "@altea/altea/client/SelectorModal";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import type { Lite } from "@altea/altea/data/lite";
import {
    TypeAllowed, TypeAllowedBasic, TypeAllowedRule, ConditionRuleModel, WithConditionsModel,
    TypeConditionSymbol, typeAllowedDB, typeAllowedUI, typeAllowedCreate,
    PropertyAllowed, OperationAllowed, QueryAllowed,
} from "../../data/Rules";
import { toInt } from "@altea/altea/data/basics";
import type { TypeRulePack, PropertyRulePack, QueryRulePack, OperationRulePack } from "../../data/Rules";
import { DimensionSummaryModel } from "../../data/Rules";
import { type Slice, sliceValue } from "./AuthSlice";
import { AuthAdminMessage } from "../../data/AuthMessages";
import { AuthAdminClient } from "./AuthAdminClient";
import { openAuthClosureModal } from "./AuthClosureModal";
import { RoleEntity } from "../../data/Role";
import { ColorRadio, GrayCheckbox } from "./ColoredRadios";
import "./AuthAdmin.css";

// Port of Signum.Authorization's Rules/TypeRulePackControl.tsx — see port/Auth.md.
//
// The VIEW component for the TypeRulePack ModelEntity, opened as a FrameModal from the Role QuickLink.
// Each type
// row shows the FALLBACK Write/Read/None radios (driving `rule.allowed.fallback`) + the "overridden"
// checkbox; below it, one sub-row per CONDITION rule (an AND-ed set of TypeConditionSymbols → its own
// Write/Read/None radios). A type with registered `availableConditions` gets a "+" to add a condition
// (a multi-select of its symbols); each condition sub-row has a "×" to remove it. Save posts the pack,
// refetches, and reloads the frame in place.
//
// Each row also carries the per-type DRILL-IN links: small icons that open the (role, type) property /
// query / operation rule pack for that row — the ONLY entry point to those per-type dimensions.
//
// DEFERRED: drag-reorder of condition rules (order still comes from add order, and last match wins), and
// the namespace grouping.

// The per-type dimension drill-ins, gated by which auth dimensions were started (AuthAdminClient.Options).
// Each is its OWN column with a header, in that order.
const SUBLINKS: { kind: "properties" | "operations" | "queries"; enabled: () => boolean; icon: IconProp; title: string; header: string; color: string }[] = [
    { kind: "properties", enabled: () => AuthAdminClient.Options.properties, icon: "pen-to-square", title: "Property rules", header: "Properties", color: "#6f42c1" },
    { kind: "operations", enabled: () => AuthAdminClient.Options.operations, icon: "bolt", title: "Operation rules", header: "Operations", color: "#0d6efd" },
    { kind: "queries", enabled: () => AuthAdminClient.Options.queries, icon: "magnifying-glass", title: "Query rules", header: "Queries", color: "green" },
];

const BASICS: { basic: TypeAllowedBasic; color: string; label: string }[] = [
    { basic: TypeAllowedBasic.Write, color: "green", label: "Write" },
    { basic: TypeAllowedBasic.Read, color: "#FFAD00", label: "Read" },
    { basic: TypeAllowedBasic.None, color: "red", label: "None" },
];

// A dimension's access summary → colour: rank 2 = all-allowed (green), 1 = partial (amber), 0 = all-none
// (red), -1 = n/a / empty (muted gray). The drill-in icon glyph takes the MAX colour and an underline
// shows the MIN — so a uniform dimension reads as one solid colour and a mixed one shows its range.
const RANK_COLOR = (rank: number): string => rank === 2 ? "green" : rank === 1 ? "#FFAD00" : rank === 0 ? "red" : "#adb5bd";
// Icon = summary of the permissions inside: glyph in the MAX colour. When the dimension is MIXED (min ≠ max)
// an underline in the MIN colour shows the range; a uniform dimension is just the solid glyph. No summary (a
// condition row added in the editor, not yet drilled into) is the n/a gray.
function renderSummaryIcon(icon: IconProp, sum: DimensionSummaryModel | null | undefined): React.JSX.Element {
    const min = sum == null ? -1 : Number(sum.min), max = sum == null ? -1 : Number(sum.max);
    const mixed = min !== max;
    return (
        <span style={{ display: "inline-block", lineHeight: 1, paddingBottom: mixed ? 1 : 0, borderBottom: mixed ? `2px solid ${RANK_COLOR(min)}` : undefined }}>
            <FontAwesomeIcon aria-hidden={true} icon={icon} color={RANK_COLOR(max)} />
        </span>
    );
}
const summaryFor = (rule: TypeAllowedRule, kind: "properties" | "operations" | "queries"): DimensionSummaryModel =>
    kind === "properties" ? rule.propertiesSummary : kind === "operations" ? rule.operationsSummary : rule.queriesSummary;
// A package name for display / grouping ("" → "Other").
const packageLabel = (rule: TypeAllowedRule): string => rule.packageName || "Other";

// Collapse a freshly-fetched sub-pack into a {min,max} access rank — so the grid icon colour can be
// recomputed after the drill-in closes (mirrors the server's sliceSummary). `slice`: a condition row's set,
// or undefined for the fallback (the type row). undefined = empty dimension.
const propRank = (a: PropertyAllowed): number => a === PropertyAllowed.None ? 0 : a === PropertyAllowed.Read ? 1 : 2;
const opRank = (a: OperationAllowed): number => a === OperationAllowed.None ? 0 : a === OperationAllowed.DBOnly ? 1 : 2;
const queryRank = (a: QueryAllowed): number => a === QueryAllowed.None ? 0 : a === QueryAllowed.EmbeddedOnly ? 1 : 2;
function summarizePack(kind: "properties" | "operations" | "queries", pack: PropertyRulePack | OperationRulePack | QueryRulePack, slice?: Slice): { min: number; max: number } | undefined {
    const ranks = kind === "queries" ? (pack as QueryRulePack).rules.map(r => queryRank(r.allowed))
        : kind === "properties" ? (pack as PropertyRulePack).rules.map(r => propRank(sliceValue(r.allowed, slice)))
            : (pack as OperationRulePack).rules.map(r => opRank(sliceValue(r.allowed, slice)));
    return ranks.length ? { min: Math.min(...ranks), max: Math.max(...ranks) } : undefined;
}

function isActive(allowed: TypeAllowed, basic: TypeAllowedBasic): boolean {
    return typeAllowedDB(allowed) === basic || typeAllowedUI(allowed) === basic;
}
function combine(a: TypeAllowedBasic, b: TypeAllowedBasic): TypeAllowed {
    return typeAllowedCreate(Math.max(a, b) as TypeAllowedBasic, Math.min(a, b) as TypeAllowedBasic);
}
// A plain click sets both DB+UI; shift/ctrl-click toggles one level to build/collapse a mixed DBxUIy value.
function select(current: TypeAllowed, basic: TypeAllowedBasic, e: React.MouseEvent<unknown>): TypeAllowed {
    if (!(e.shiftKey || e.ctrlKey))
        return typeAllowedCreate(basic, basic);
    const db = typeAllowedDB(current), ui = typeAllowedUI(current);
    if (db !== ui) {
        if (basic === ui) return typeAllowedCreate(db, db);
        if (basic === db) return typeAllowedCreate(ui, ui);
        return current;
    }
    return basic !== db ? combine(db, basic) : current;
}

const shortKey = (l: Lite<TypeConditionSymbol>): string => {
    const s = l.toString();
    const dot = s.indexOf(".");
    return dot >= 0 ? s.substring(dot + 1) : s;
};
const condSetKey = (tcs: Lite<TypeConditionSymbol>[]): string => tcs.map(l => String(l.id)).sort().join("&");

// Signum's type filter box, verbatim in grammar: `+term` / `-term` (a bare term is `+`), read from the
// LAST term back and the first that matches decides — so "Auth-!overriden" is "the Auth types, except the
// overridden ones". `*` matches everything. A term matches as a case-insensitive substring of the
// package, clean name or nice name, or — prefixed with `!` — as a command, any prefix of its name:
//   !overriden   the type's rule differs from what it inherits
//   !conditions  the type has type conditions registered
function matchesFilter(filter: string, rule: TypeAllowedRule): boolean {
    const parts = filter.match(/[+-]?((!?\w+)|\*)/g);
    if (!parts || parts.length == 0)
        return true;
    const typeName = rule.resource.toString();
    const str = [rule.packageName, typeName, tryGetTypeInfo(typeName)?.getNiceName() ?? ""].join("|").toLowerCase();
    for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]!;
        const isPositive = !p.startsWith("-");
        const token = p.startsWith("+") || p.startsWith("-") ? p.substring(1) : p;
        if (token == "*")
            return isPositive;
        if (token.startsWith("!")) {
            const command = token.substring(1).toLowerCase();
            if ("overriden".startsWith(command) && !withConditionsEquals(rule.allowed, rule.allowedBase))
                return isPositive;
            if ("conditions".startsWith(command) && rule.availableConditions.length > 0)
                return isPositive;
        }
        if (str.includes(token.toLowerCase()))
            return isPositive;
    }
    return false;
}

// Structural fallback + conditions equality — drives the "overridden" flag.
function withConditionsEquals(a: WithConditionsModel, b: WithConditionsModel): boolean {
    if (a.fallback !== b.fallback || a.conditionRules.length !== b.conditionRules.length)
        return false;
    return a.conditionRules.every((cr, i) => {
        const bcr = b.conditionRules[i];
        return cr.allowed === bcr.allowed && condSetKey(cr.typeConditions) === condSetKey(bcr.typeConditions);
    });
}
function cloneModel(m: WithConditionsModel): WithConditionsModel {
    return WithConditionsModel.create({
        fallback: m.fallback,
        conditionRules: m.conditionRules.map(cr => ConditionRuleModel.create({ typeConditions: [...cr.typeConditions], allowed: cr.allowed })),
    });
}

export default function TypeRulePackControl({ ctx, ref }: { ctx: TypeContext<TypeRulePack>; ref?: React.Ref<IRenderButtons & IHasChanges> }): React.JSX.Element {

    const dirty = React.useRef(false);
    React.useEffect(() => { dirty.current = false; }, [ctx.value]);
    const forceUpdate = (): void => ctx.frame!.frameComponent.forceUpdate();
    const markDirty = (): void => { dirty.current = true; forceUpdate(); };

    const [filter, setFilter] = React.useState("");
    const isMatch = (rule: TypeAllowedRule): boolean => matchesFilter(filter, rule);

    function renderButtons(bc: ButtonsContext): ButtonBarElement[] {
        // Track edits via the explicit `dirty` ref (set by markDirty on every change, cleared on reload),
        // NOT isGraphModified: a freshly-loaded pack ModelEntity graph reports modified, which wrongly
        // enabled Save / Reset and DISABLED "Switch to…". Signum likewise keys these buttons off its own
        // `modified` flag, not a graph diff.
        const hasChanges = dirty.current;
        return [
            { button: <Button type="button" variant="primary" disabled={!hasChanges || ctx.readOnly} onClick={() => handleSaveClick(bc)}>{AuthAdminMessage.Save.niceToString()}</Button> },
            { button: <Button type="button" variant="warning" disabled={!hasChanges || ctx.readOnly} onClick={() => handleResetClick(bc)}>{AuthAdminMessage.ResetChanges.niceToString()}</Button> },
            { button: <Button type="button" variant="info" disabled={hasChanges} onClick={() => handleSwitchToClick(bc)}>{AuthAdminMessage.SwitchTo.niceToString()}</Button> },
        ];
    }
    // `entityHasChanges`: the frame's "you will lose changes" check asks THIS rather than diffing the pack,
    // which the editor also writes to for display (e.g. the grid's summary icons after a drill-in).
    React.useImperativeHandle(ref, () => ({ renderButtons, entityHasChanges: () => dirty.current }), [ctx.value]);

    function handleSaveClick(bc: ButtonsContext): void {
        const pack = ctx.value;
        void AuthAdminClient.API.saveTypeRulePack(pack)
            .then(() => AuthAdminClient.API.fetchTypeRulePack(pack.role.id!))
            .then(newPack => { Operations.notifySuccess(); bc.frame.onReload({ entity: newPack, canExecute: {} }); });
    }
    function handleResetClick(bc: ButtonsContext): void {
        void AuthAdminClient.API.fetchTypeRulePack(ctx.value.role.id!)
            .then(newPack => bc.frame.onReload({ entity: newPack, canExecute: {} }));
    }
    function handleSwitchToClick(bc: ButtonsContext): void {
        void Finder.find(RoleEntity).then(r => {
            if (!r) return;
            void AuthAdminClient.API.fetchTypeRulePack(r.id!)
                .then(newPack => bc.frame.onReload({ entity: newPack, canExecute: {} }));
        });
    }

    // Open the (role, type) pack of a per-type dimension. typeName = the row's TypeEntity cleanName
    // (rule.resource.toString()), exactly what the pack API's `:typeName` resolves via Entity.resolveType.
    // If the type OWNS parts (altea's MList replacement, hidden from this grid), the drill-in shows one
    // editable table per type — owner + parts — stacked in a single modal (AuthClosureModal); otherwise
    // it opens the single pack the classic way (Navigator.view).
    // `initialTypeConditions` (from a type-CONDITION row's drill-in) preselects that condition slice in the
    // opened property / operation pack: a condition row's link is already filtered to that condition.
    async function openSubPack(kind: "properties" | "queries" | "operations", rule: TypeAllowedRule, initialTypeConditions?: Lite<TypeConditionSymbol>[]): Promise<void> {
        const roleId = ctx.value.role.id!;
        const roleStr = ctx.value.role.toString();
        const typeName = rule.resource.toString();
        const fetchOne = (tn: string): Promise<PropertyRulePack | QueryRulePack | OperationRulePack> =>
            kind === "properties" ? AuthAdminClient.API.fetchPropertyRulePack(tn, roleId)
                : kind === "queries" ? AuthAdminClient.API.fetchQueryRulePack(tn, roleId)
                    : AuthAdminClient.API.fetchOperationRulePack(tn, roleId);
        const closure = await AuthAdminClient.API.fetchPartClosure(typeName);
        if (closure.length <= 1) {
            const label = kind === "properties" ? "Property rules" : kind === "queries" ? "Query rules" : "Operation rules";
            await Navigator.view(await fetchOne(typeName), { buttons: "close", title: label + " — " + typeName + " / " + roleStr, extraProps: { initialTypeConditions } });
        } else {
            const packs = await Promise.all(closure.map(fetchOne));
            await openAuthClosureModal({ kind, roleId, roleStr, packs, readOnly: ctx.readOnly, initialTypeConditions });
        }
        // The sub-pack(s) may have been edited + saved; re-collapse the OWNER + its associated parts into
        // this row's summary so the drill-in icon colour reflects the whole editable closure (min of mins /
        // max of maxes), matching the server-side summary — not just the main entity.
        // The condition rows too: an edit in the drill-in may have changed any slice.
        const fresh = await Promise.all(closure.map(fetchOne));
        const collapse = (slice: Slice): DimensionSummaryModel => {
            const summaries = fresh.map(p => summarizePack(kind, p, slice)).filter((x): x is { min: number; max: number } => x != null);
            return DimensionSummaryModel.create({
                min: toInt(summaries.length ? Math.min(...summaries.map(s => s.min)) : -1),
                max: toInt(summaries.length ? Math.max(...summaries.map(s => s.max)) : -1),
            });
        };
        const fallback = collapse(undefined);
        const target = kind === "properties" ? rule.propertiesSummary : kind === "operations" ? rule.operationsSummary : rule.queriesSummary;
        target.min = fallback.min;
        target.max = fallback.max;
        if (kind !== "queries")
            for (const cr of rule.allowed.conditionRules) {
                if (kind === "properties") cr.propertiesSummary = collapse(cr.typeConditions);
                else cr.operationsSummary = collapse(cr.typeConditions);
            }
        forceUpdate();
    }

    async function addCondition(rule: TypeAllowedRule): Promise<void> {
        const ti = tryGetTypeInfo(rule.resource.toString());
        const typeName = ti?.getNiceName() ?? rule.resource.toString();
        const typePlural = ti?.getNicePluralName() ?? typeName;

        const chosen = await SelectorModal.chooseManyElement(rule.availableConditions, {
            buttonDisplay: shortKey,
            title: AuthAdminMessage.SelectTypeConditions.niceToString(),
            // Three parts, as Signum: how many conditions this type has, what picking ONE does, and what
            // picking SEVERAL does — the AND is the part a first-time reader gets wrong.
            message: <div>
                <p>{AuthAdminMessage.ThereAre0TypeConditionsDefinedFor1.niceToString()
                    .formatHtml(<strong>{rule.availableConditions.length}</strong>, <strong>{typeName}</strong>)}</p>
                <p>{AuthAdminMessage.SelectOneToOverrideTheAccessFor0ThatSatisfyThisCondition.niceToString()
                    .formatHtml(<strong>{typePlural}</strong>)}</p>
                <p>{AuthAdminMessage.SelectMoreThanOneToOverrideAccessFor0ThatSatisfyAllTheConditionsAtTheSameTime.niceToString()
                    .formatHtml(<strong>{typePlural}</strong>)}</p>
            </div>,
            size: "md",
        });
        if (chosen == null || chosen.length === 0)
            return;
        const key = condSetKey(chosen);
        if (rule.allowed.conditionRules.some(cr => condSetKey(cr.typeConditions) === key)) {
            // Signum REFUSES here, naming the set. Silently returning left the button looking broken:
            // the user clicks Add, picks the same pair again, and nothing happens with no explanation.
            await MessageModal.showError(
                <div>
                    <p>{AuthAdminMessage.TheFollowingTypeConditionsHaveAlreadyBeenUsed.niceToString()}</p>
                    <p><strong>{chosen.map(shortKey).sort().join(" & ")}</strong></p>
                </div>,
                AuthAdminMessage.RepeatedTypeCondition.niceToString());
            return;
        }
        rule.allowed.conditionRules.push(ConditionRuleModel.create({ typeConditions: chosen, allowed: TypeAllowed.None }));
        markDirty();
    }
    function removeCondition(rule: TypeAllowedRule, cr: ConditionRuleModel): void {
        rule.allowed.conditionRules = rule.allowed.conditionRules.filter(x => x !== cr);
        markDirty();
    }

    // A Write/Read/None radio bound to a TypeAllowed getter/setter (the fallback, or a condition's allowed).
    const renderRadio = (get: () => TypeAllowed, set: (v: TypeAllowed) => void, basic: TypeAllowedBasic, color: string): React.JSX.Element => {
        const allowed = get();
        const active = isActive(allowed, basic);
        const dbEq = typeAllowedDB(allowed) === basic, uiEq = typeAllowedUI(allowed) === basic;
        const niceName = TypeAllowedBasic[basic];
        const title = !active || (dbEq && uiEq) ? niceName
            : dbEq ? AuthAdminMessage._0InDB.niceToString(niceName) : AuthAdminMessage._0InUI.niceToString(niceName);
        const icon: IconProp | undefined = !active || (dbEq && uiEq) ? undefined : dbEq ? "database" : "window-restore";
        return <ColorRadio checked={active} title={title} color={color} icon={icon} readOnly={ctx.readOnly}
            onClicked={e => { set(select(get(), basic, e)); markDirty(); }} />;
    };

    return (
        <div>
            <div className="form-compact mb-2">
                <EntityLine ctx={ctx.subCtx(f => f.role)} readOnly={true} />
                <AutoLine ctx={ctx.subCtx(f => f.strategy)} readOnly={true} />
            </div>
            <div className="mb-2" style={{ maxWidth: "44rem" }}>
                <input type="text" className="form-control form-control-sm" placeholder="Auth-!overriden+!conditions"
                    title="+term / -term (the last matching term decides), * = all, !overriden, !conditions"
                    value={filter} onChange={e => setFilter(e.currentTarget.value)} />
            </div>
            <table className="table table-sm table-hover sf-auth-rules" style={{ maxWidth: "44rem" }}
                aria-label={AuthAdminMessage.TypePermissionOverview.niceToString()}>
                <thead>
                    <tr>
                        <th>Type</th>
                        {BASICS.map(b => <th key={b.label} className="text-center">{b.label}</th>)}
                        <th className="text-center">{AuthAdminMessage.Overriden.niceToString()}</th>
                        {SUBLINKS.filter(s => s.enabled()).map(s => <th key={s.kind} className="text-center">{s.header}</th>)}
                    </tr>
                </thead>
                <tbody>
                    {(() => {
                        // Group the visible rows by owning PACKAGE; a header row precedes each package's
                        // rows.
                        const groups = new Map<string, TypeAllowedRule[]>();
                        for (const r of ctx.value.rules.filter(isMatch)) {
                            const k = packageLabel(r);
                            const arr = groups.get(k);
                            if (arr) arr.push(r); else groups.set(k, [r]);
                        }
                        const colCount = 5 + SUBLINKS.filter(s => s.enabled()).length;
                        return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).flatMap(([pkg, rules]) => [
                            <tr key={"pkg:" + pkg} className="sf-auth-namespace">
                                <td colSpan={colCount}><b>{pkg}</b></td>
                            </tr>,
                            ...rules.flatMap(rule => {
                                const ti = tryGetTypeInfo(rule.resource.toString());
                                const isMaster = ti?.entityData === "Master";
                                return [
                                    <tr key={String(rule.resource.id)}>
                                        <td>
                                            {!ctx.readOnly && rule.availableConditions.length > 0
                                                ? <LinkButton className="sf-condition-icon me-2" title={AuthAdminMessage.AddCondition.niceToString()} onClick={() => void addCondition(rule)}>
                                                    <FontAwesomeIcon aria-hidden={true} icon="circle-plus" />
                                                </LinkButton>
                                                : <FontAwesomeIcon aria-hidden={true} icon="circle" className="sf-placeholder-icon me-2" />}
                                            {rule.resource.toString()}
                                            {isMaster && <small className="sf-entity-data ms-1" title={AuthAdminMessage.MasterEntity.niceToString()}>M</small>}
                                            {rule.ownedParts.length > 0 &&
                                                <small className="sf-owned-parts ms-2" title={AuthAdminMessage.OwnsParts0.niceToString(rule.ownedParts.join(", "))}>
                                                    <FontAwesomeIcon aria-hidden={true} icon="puzzle-piece" /> {rule.ownedParts.length}
                                                </small>}
                                        </td>
                                        {BASICS.map((b, i) => <td key={b.label} className={classes("text-center", i === 0 && isMaster ? "sf-master" : undefined)}>
                                            {renderRadio(() => rule.allowed.fallback, v => rule.allowed.fallback = v, b.basic, b.color)}
                                        </td>)}
                                        <td className="text-center">
                                            <GrayCheckbox readOnly={ctx.readOnly} checked={!withConditionsEquals(rule.allowed, rule.allowedBase)}
                                                onUnchecked={() => { rule.allowed = cloneModel(rule.allowedBase); markDirty(); }} />
                                        </td>
                                        {SUBLINKS.filter(s => s.enabled()).map(s =>
                                            <td key={s.kind} className="text-center">
                                                <LinkButton className="sf-auth-link" title={s.title} onClick={() => void openSubPack(s.kind, rule)}>
                                                    {renderSummaryIcon(s.icon, summaryFor(rule, s.kind))}
                                                </LinkButton>
                                            </td>)}
                                    </tr>,
                                    ...rule.allowed.conditionRules.map((cr, i) => (
                                        <tr key={String(rule.resource.id) + "_c" + i} className="table-active">
                                            <td className="ps-4">
                                                {/* Read-only keeps the PLACEHOLDER (as the type row above does), so the condition
                                                    label stays in the same column instead of shifting left. */}
                                                {ctx.readOnly
                                                    ? <FontAwesomeIcon aria-hidden={true} icon="circle" className="sf-placeholder-icon me-2" />
                                                    : <LinkButton className="sf-condition-icon me-2" title={AuthAdminMessage.RemoveCondition.niceToString()} onClick={() => removeCondition(rule, cr)}>
                                                        <FontAwesomeIcon aria-hidden={true} icon="circle-minus" />
                                                    </LinkButton>}
                                                <small>{cr.typeConditions.map(shortKey).join(" & ")}</small>
                                            </td>
                                            {BASICS.map((b, j) => <td key={b.label} className={classes("text-center", j === 0 && isMaster ? "sf-master" : undefined)}>
                                                {renderRadio(() => cr.allowed, v => cr.allowed = v, b.basic, b.color)}
                                            </td>)}
                                            <td />
                                            {/* One cell per dimension column. Property/operation drill-ins are scoped to
                                                THIS condition, and coloured by its own summary; the Query column stays
                                                empty (queries have no type conditions). */}
                                            {SUBLINKS.filter(s => s.enabled()).map(s =>
                                                <td key={s.kind} className="text-center">
                                                    {s.kind !== "queries" &&
                                                        <LinkButton className="sf-auth-link" title={s.title} onClick={() => void openSubPack(s.kind, rule, cr.typeConditions)}>
                                                            {renderSummaryIcon(s.icon, s.kind === "properties" ? cr.propertiesSummary : cr.operationsSummary)}
                                                        </LinkButton>}
                                                </td>)}
                                        </tr>
                                    )),
                                ];
                            }),
                        ]);
                    })()}
                </tbody>
            </table>
        </div>
    );
}
