import * as React from "react";
import { Button } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconProp } from "@fortawesome/fontawesome-svg-core";
import { TypeContext } from "@altea/altea/client/TypeContext";
import type { IRenderButtons, ButtonsContext, ButtonBarElement } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { Operations } from "@altea/altea/client/Operations";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import { tryGetTypeInfo } from "@altea/altea/client/Reflection";
import { classes } from "@altea/altea/data/globals";
import SelectorModal from "@altea/altea/client/SelectorModal";
import type { Lite } from "@altea/altea/data/lite";
import {
    TypeAllowed, TypeAllowedBasic, TypeAllowedRule, ConditionRuleModel, WithConditionsModel,
    TypeConditionSymbol, typeAllowedDB, typeAllowedUI, typeAllowedCreate,
    PropertyAllowed, OperationAllowed, QueryAllowed,
} from "../../data/Rules";
import { toInt } from "@altea/altea/data/basics";
import type { TypeRulePack, PropertyRulePack, QueryRulePack, OperationRulePack, DimensionSummaryModel } from "../../data/Rules";
import { AuthAdminMessage } from "../../data/AuthMessages";
import { AuthAdminClient } from "./AuthAdminClient";
import { openAuthClosureModal } from "./AuthClosureModal";
import { RoleEntity } from "../../data/Role";
import { ColorRadio, GrayCheckbox } from "./ColoredRadios";
import "./AuthAdmin.css";

// Port of Signum's TypeRulePackControl (Rules/TypeRulePackControl.tsx). The VIEW component for the
// TypeRulePack ModelEntity, opened as a FrameModal via Navigator.view from the Role QuickLink. Each type
// row shows the FALLBACK Write/Read/None radios (driving `rule.allowed.fallback`) + the "overridden"
// checkbox; below it, one sub-row per CONDITION rule (an AND-ed set of TypeConditionSymbols → its own
// Write/Read/None radios). A type with registered `availableConditions` gets a "+" to add a condition
// (a multi-select of its symbols); each condition sub-row has a "×" to remove it. Save posts the pack,
// refetches, and reloads the frame (Signum's IRenderButtons in-place Save).
//
// Each row also carries the per-type drill-in links (Signum's property/operation/query thumbnails): small
// icons that open the (role, type) property / query / operation rule pack for that row — the ONLY entry
// point to those per-type dimensions (there is no Role-level QuickLink for them, matching Signum).
//
// Deferred vs Signum: drag-reorder of condition rules (order still comes from add order; last matches
// win) and the namespace grouping.

// The per-type dimension drill-ins, gated by which auth dimensions were started (AuthAdminClient.Options).
// Each is its OWN column with a header (like Signum's Property / Operation / Query columns), in that order.
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
const summaryFor = (rule: TypeAllowedRule, kind: "properties" | "operations" | "queries"): DimensionSummaryModel =>
    kind === "properties" ? rule.propertiesSummary : kind === "operations" ? rule.operationsSummary : rule.queriesSummary;
// A package name for display / grouping ("" → "Other").
const packageLabel = (rule: TypeAllowedRule): string => rule.packageName || "Other";

// Collapse a freshly-fetched sub-pack into a {min,max} access rank — so the grid icon colour can be
// recomputed after the drill-in closes (mirrors the server's fallbackSummary). undefined = empty dimension.
const propRank = (a: PropertyAllowed): number => a === PropertyAllowed.None ? 0 : a === PropertyAllowed.Read ? 1 : 2;
const opRank = (a: OperationAllowed): number => a === OperationAllowed.None ? 0 : a === OperationAllowed.DBOnly ? 1 : 2;
const queryRank = (a: QueryAllowed): number => a === QueryAllowed.None ? 0 : a === QueryAllowed.EmbeddedOnly ? 1 : 2;
function summarizePack(kind: "properties" | "operations" | "queries", pack: PropertyRulePack | OperationRulePack | QueryRulePack): { min: number; max: number } | undefined {
    const ranks = kind === "queries" ? (pack as QueryRulePack).rules.map(r => queryRank(r.allowed))
        : kind === "properties" ? (pack as PropertyRulePack).rules.map(r => propRank(r.allowed.fallback))
            : (pack as OperationRulePack).rules.map(r => opRank(r.allowed.fallback));
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

// Structural fallback+conditions equality (Signum's withConditionsEquals) — drives the "overridden" flag.
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

export default function TypeRulePackControl({ ctx, ref }: { ctx: TypeContext<TypeRulePack>; ref?: React.Ref<IRenderButtons> }): React.JSX.Element {

    const dirty = React.useRef(false);
    React.useEffect(() => { dirty.current = false; }, [ctx.value]);
    const forceUpdate = (): void => ctx.frame!.frameComponent.forceUpdate();
    const markDirty = (): void => { dirty.current = true; forceUpdate(); };

    // Type filter box (Signum's namespace/className search). altea keeps it simple: a case-insensitive
    // substring match on the type's nice name; empty = show all.
    const [filter, setFilter] = React.useState("");
    const isMatch = (rule: TypeAllowedRule): boolean =>
        filter.trim() === "" || rule.resource.toString().toLowerCase().includes(filter.trim().toLowerCase());

    function renderButtons(bc: ButtonsContext): ButtonBarElement[] {
        // Track edits via the explicit `dirty` ref (set by markDirty on every change, cleared on reload),
        // NOT isGraphModified: a freshly-loaded pack ModelEntity graph reports modified, which wrongly
        // enabled Save/Reset and DISABLED "Switch to…". Signum likewise keys these buttons off its own
        // `modified` flag, not a graph diff.
        const hasChanges = dirty.current;
        return [
            { button: <Button type="button" variant="primary" disabled={!hasChanges || ctx.readOnly} onClick={() => handleSaveClick(bc)}>{AuthAdminMessage.Save.niceToString()}</Button> },
            { button: <Button type="button" variant="warning" disabled={!hasChanges || ctx.readOnly} onClick={() => handleResetClick(bc)}>{AuthAdminMessage.ResetChanges.niceToString()}</Button> },
            { button: <Button type="button" variant="info" disabled={hasChanges} onClick={() => handleSwitchToClick(bc)}>{AuthAdminMessage.SwitchTo.niceToString()}</Button> },
        ];
    }
    React.useImperativeHandle(ref, () => ({ renderButtons }), [ctx.value]);

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
    // opened property/operation pack — Signum's "each condition row has its own already-filtered link".
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
        // The sub-pack may have been edited + saved; re-collapse the OWNER's pack into this row's summary
        // so the drill-in icon colour reflects the new state (Signum recomputes its thumbnail on close).
        const s = summarizePack(kind, await fetchOne(typeName));
        const target = kind === "properties" ? rule.propertiesSummary : kind === "operations" ? rule.operationsSummary : rule.queriesSummary;
        target.min = toInt(s?.min ?? -1);
        target.max = toInt(s?.max ?? -1);
        forceUpdate();
    }

    async function addCondition(rule: TypeAllowedRule): Promise<void> {
        const chosen = await SelectorModal.chooseManyElement(rule.availableConditions, {
            buttonDisplay: shortKey,
            title: AuthAdminMessage.TypeRules.niceToString(),
            message: "Select the type condition(s) that must ALL hold for this rule to apply.",
        });
        if (chosen == null || chosen.length === 0)
            return;
        const key = condSetKey(chosen);
        if (rule.allowed.conditionRules.some(cr => condSetKey(cr.typeConditions) === key))
            return; // repeated condition set — ignore (Signum shows an error modal)
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
                <input type="text" className="form-control form-control-sm" placeholder={AuthAdminMessage.Search.niceToString()}
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
                        // Group the visible rows by owning package (Signum groups by namespace); a header row
                        // precedes each package's rows.
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
                                                ? <LinkButton className="sf-condition-icon me-2" title="Add condition" onClick={() => void addCondition(rule)}>
                                                    <FontAwesomeIcon aria-hidden={true} icon="circle-plus" />
                                                </LinkButton>
                                                : <FontAwesomeIcon aria-hidden={true} icon="circle" className="sf-placeholder-icon me-2" />}
                                            {rule.resource.toString()}
                                            {isMaster && <small className="sf-entity-data ms-1" title="Master">M</small>}
                                            {rule.ownedParts.length > 0 &&
                                                <small className="sf-owned-parts ms-2" title={"Owns parts: " + rule.ownedParts.join(", ")}>
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
                                        {SUBLINKS.filter(s => s.enabled()).map(s => {
                                            // Icon = summary of the permissions inside: glyph in the MAX colour. When the
                                            // dimension is MIXED (min ≠ max) an underline in the MIN colour shows the range;
                                            // a uniform dimension is just the solid glyph (no underline).
                                            const sum = summaryFor(rule, s.kind);
                                            const mixed = Number(sum.min) !== Number(sum.max);
                                            return (
                                                <td key={s.kind} className="text-center">
                                                    <LinkButton className="sf-auth-link" title={s.title} onClick={() => void openSubPack(s.kind, rule)}>
                                                        <span style={{ display: "inline-block", lineHeight: 1, paddingBottom: mixed ? 1 : 0, borderBottom: mixed ? `2px solid ${RANK_COLOR(Number(sum.min))}` : undefined }}>
                                                            <FontAwesomeIcon aria-hidden={true} icon={s.icon} color={RANK_COLOR(Number(sum.max))} />
                                                        </span>
                                                    </LinkButton>
                                                </td>
                                            );
                                        })}
                                    </tr>,
                                    ...rule.allowed.conditionRules.map((cr, i) => (
                                        <tr key={String(rule.resource.id) + "_c" + i} className="table-active">
                                            <td className="ps-4">
                                                {!ctx.readOnly &&
                                                    <LinkButton className="sf-condition-icon me-2" title="Remove condition" onClick={() => removeCondition(rule, cr)}>
                                                        <FontAwesomeIcon aria-hidden={true} icon="circle-minus" />
                                                    </LinkButton>}
                                                <small>{cr.typeConditions.map(shortKey).join(" & ")}</small>
                                            </td>
                                            {BASICS.map((b, j) => <td key={b.label} className={classes("text-center", j === 0 && isMaster ? "sf-master" : undefined)}>
                                                {renderRadio(() => cr.allowed, v => cr.allowed = v, b.basic, b.color)}
                                            </td>)}
                                            <td />
                                            {/* One cell per dimension column. Property/operation drill-ins are scoped to
                                                THIS condition (Signum: each condition row has its own already-filtered
                                                link); the Query column stays empty (queries have no type conditions).
                                                Neutral colour — no per-condition summary computed. */}
                                            {SUBLINKS.filter(s => s.enabled()).map(s =>
                                                <td key={s.kind} className="text-center">
                                                    {s.kind !== "queries" &&
                                                        <LinkButton className="sf-auth-link" title={s.title} onClick={() => void openSubPack(s.kind, rule, cr.typeConditions)}>
                                                            <FontAwesomeIcon aria-hidden={true} icon={s.icon} color="#6c757d" />
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
