import * as React from "react";
import { Accordion } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Binding } from "@altea/altea/client/binding";
import { classes } from "@altea/altea/data/globals/helpers";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { EntityControlMessage } from "@altea/altea/data/uiMessages";
import ValueComponent, { type DynamicTypeDesignContext } from "./ValueComponent";
import type { DynamicProperty, DynamicValidator } from "../../data/DynamicType";
import { IsNullableValues, DynamicUniqueIndexValues } from "../../data/DynamicType";

// Port of the PROPERTY half of Signum.Dynamic's Type/DynamicTypeDefinitionComponent.tsx
// (PropertyRepeaterComponent / PropertyComponent / TypeCombo / ValidatorRepeaterComponent, plus the type
// predicates and `autoFix`).
//
// altea divergence in FILE LAYOUT: Signum keeps all of this in one 1,572-line file with the definition
// editor. The properties are the half that is edited most and read most, so they live here and the
// definition tabs live next door — nothing else about the split is meaningful.
//
// Behavioural divergences:
//  - **the previewed type is computed CLIENT-side** (`propertyTypeOf`), where Signum round-trips to
//    `DynamicTypeClient.API.getPropertyType` and caches the answer on a `_propertyType_` field it then has
//    to strip before saving (`beforeSave`). The composition is `Lite<X>`, `X[]`, `| null` — pure string
//    work over data the client already has — so a request per property buys nothing, and the definition
//    stays free of a transient field.
//  - `IsMList` keeps Signum's NAME in the stored definition (so a definition round-trips between the two
//    frameworks) but the editor labels it "Is collection", because that is what it produces here: a
//    generated `@part` row type, not an MList table. Its four options mean the same things.
//  - Signum's `TypeCombo` autocompletes against `TypeHelpClient.API.autocompleteType`. TypeHelp is not
//    ported (the honest equivalent is editor IntelliSense over the same `.d.ts` — see @altea/altea-eval),
//    so this is a plain text box with the value types offered as a datalist.

// ---- type predicates (Signum's, verbatim) --------------------------------------------------------------

const valueTypes = [
    "string", "boolean", "int", "long", "decimal", "double",
    "PlainDate", "PlainDateTime", "PlainTime", "Duration", "Guid", "byte[]",
];

function isReferenceType(type: string): boolean {
    return type.endsWith("Entity") || type.endsWith("Embedded") || type.endsWith("Mixin");
}

function isString(type: string): boolean { return type === "string"; }
function isDateTime(type: string): boolean { return type === "PlainDateTime" || type === "DateTime"; }
function isInteger(type: string): boolean { return type === "int" || type === "long"; }
function isDecimal(type: string): boolean { return type === "decimal"; }
function isReal(type: string): boolean { return type === "double" || type === "float" || isDecimal(type); }
function isEntity(type: string): boolean { return type.endsWith("Entity"); }
function isEmbedded(type: string): boolean { return type.endsWith("Embedded") || type.endsWith("Mixin"); }
function allowsSize(type: string): boolean { return isString(type) || type === "byte[]" || isDecimal(type); }
function allowUnit(type: string): boolean { return isInteger(type) || isReal(type); }
function allowFormat(type: string): boolean { return isInteger(type) || isReal(type) || isDateTime(type); }

/**
 * Signum's `autoFix` — keep the options that cannot apply from lingering on a property whose type changed.
 *
 * Without it a `size` set while the property was a string stays in the stored definition after it becomes
 * an int, and the generator would emit a column option that means nothing.
 */
function autoFix(dp: DynamicProperty): void {
    const type = dp.type ?? "";

    if (!isEntity(type))
        delete dp.isLite;

    if (!allowsSize(type))
        delete dp.size;

    if (!isDecimal(type))
        delete dp.scale;

    if (!allowUnit(type))
        delete dp.unit;

    if (!allowFormat(type))
        delete dp.format;

    if (!isReferenceType(type) && dp.isMList == null)
        delete dp.notifyChanges;
}

/**
 * The TypeScript type the generator will emit for this property — the same composition
 * DynamicTypeLogic.getPropertyType performs, done here so the editor can show it without a round-trip.
 */
export function propertyTypeOf(dp: DynamicProperty): string {
    if (dp.type == null || dp.type === "")
        return "";

    let result = dp.type;

    if (dp.isLite === true)
        result = "Lite<" + result + ">";

    if (dp.isMList != null)
        return result + "[]";

    const nullable = dp.isNullable === "Yes" || dp.isNullable === "OnlyInMemory";
    return result + (nullable ? " | null" : "");
}

// ---- the repeater --------------------------------------------------------------------------------------

export interface PropertyRepeaterComponentProps {
    dc: DynamicTypeDesignContext;
    properties: DynamicProperty[];
    onRemove?: (property: DynamicProperty) => void;
    showDatabaseMapping: boolean;
}

export function PropertyRepeaterComponent(p: PropertyRepeaterComponentProps): React.JSX.Element {
    const [activeKey, setActiveKey] = React.useState<string | undefined>("0");

    function handleOnRemove(e: React.MouseEvent<unknown>, index: number): void {
        e.preventDefault();
        const old = p.properties[index];
        p.properties.splice(index, 1);
        if (activeKey === String(index))
            setActiveKey(undefined);
        p.dc.refreshView();
        p.onRemove?.(old);
    }

    function move(e: React.MouseEvent<unknown>, index: number, delta: number): void {
        e.preventDefault();
        const target = index + delta;
        if (target < 0 || target >= p.properties.length)
            return;

        const [item] = p.properties.splice(index, 1);
        p.properties.splice(target, 0, item);
        setActiveKey(String(target));
        p.dc.refreshView();
    }

    function handleCreateClick(e: React.SyntheticEvent<unknown>): void {
        e.preventDefault();
        const dp: DynamicProperty = {
            uid: crypto.randomUUID(), // Signum hand-rolls a v4 guid; the platform has one
            name: "Name",
            type: "string",
            isNullable: "No",
            uniqueIndex: "No",
        };
        autoFix(dp);
        p.properties.push(dp);
        setActiveKey(String(p.properties.length - 1));
        p.dc.refreshView();
    }

    return (
        <div className="properties">
            <Accordion activeKey={activeKey} onSelect={k => setActiveKey(k as string | undefined)}>
                {p.properties.map((prop, i) =>
                    <Accordion.Item eventKey={String(i)} key={prop.uid}>
                        <Accordion.Header>
                            <span className="item-group me-2">
                                <LinkButton className={classes("sf-line-button", "sf-remove")}
                                    onClick={e => handleOnRemove(e, i)}
                                    title={EntityControlMessage.Remove.niceToString()}>
                                    <FontAwesomeIcon aria-hidden={true} icon="xmark" />
                                </LinkButton>
                                <LinkButton className={classes("sf-line-button", "move-up")}
                                    onClick={e => move(e, i, -1)}
                                    title={EntityControlMessage.MoveUp.niceToString()}>
                                    <FontAwesomeIcon aria-hidden={true} icon="chevron-up" />
                                </LinkButton>
                                <LinkButton className={classes("sf-line-button", "move-down")}
                                    onClick={e => move(e, i, 1)}
                                    title={EntityControlMessage.MoveDown.niceToString()}>
                                    <FontAwesomeIcon aria-hidden={true} icon="chevron-down" />
                                </LinkButton>
                            </span>
                            <strong>{prop.name}</strong>
                            <small className="ms-2 text-muted">{propertyTypeOf(prop)}</small>
                        </Accordion.Header>
                        <Accordion.Body>
                            <PropertyComponent property={prop} dc={p.dc}
                                showDatabaseMapping={p.showDatabaseMapping} />
                        </Accordion.Body>
                    </Accordion.Item>)}
            </Accordion>

            <LinkButton className="sf-line-button sf-create mt-2" onClick={handleCreateClick}
                title={EntityControlMessage.Create.niceToString()}>
                <FontAwesomeIcon aria-hidden={true} icon="plus" /> {EntityControlMessage.Create.niceToString()}
            </LinkButton>
        </div>
    );
}

// ---- one property --------------------------------------------------------------------------------------

export interface PropertyComponentProps {
    property: DynamicProperty;
    dc: DynamicTypeDesignContext;
    showDatabaseMapping: boolean;
}

export function PropertyComponent(p: PropertyComponentProps): React.JSX.Element {
    const dp = p.property;
    const dc = p.dc;
    const type = dp.type ?? "";

    function handleAutoFix(): void {
        autoFix(dp);
        dc.refreshView();
    }

    return (
        <div>
            <div className="row">
                <div className="col-sm-6">
                    <ValueComponent dc={dc} labelColumns={4} binding={Binding.create(dp, d => d.name)}
                        type="string" defaultValue={null} onBlur={handleAutoFix} />
                    {p.showDatabaseMapping &&
                        <ValueComponent dc={dc} labelColumns={4} binding={Binding.create(dp, d => d.columnName)}
                            type="string" defaultValue={null} labelClass="database-mapping" />}

                    <TypeCombo dc={dc} labelColumns={4} binding={Binding.create(dp, d => d.type)} onBlur={handleAutoFix} />

                    {p.showDatabaseMapping &&
                        <ValueComponent dc={dc} labelColumns={4} binding={Binding.create(dp, d => d.columnType)}
                            type="string" defaultValue={null} labelClass="database-mapping" />}

                    <ValueComponent dc={dc} labelColumns={4} binding={Binding.create(dp, d => d.isNullable)}
                        type="string" defaultValue={"No"} avoidDelete onChange={handleAutoFix}
                        options={IsNullableValues} />

                    {allowUnit(type) &&
                        <ValueComponent dc={dc} labelColumns={4} binding={Binding.create(dp, d => d.unit)}
                            type="string" defaultValue={null} />}

                    {allowFormat(type) &&
                        <ValueComponent dc={dc} labelColumns={4} binding={Binding.create(dp, d => d.format)}
                            type="string" defaultValue={null} />}
                </div>

                <div className="col-sm-6">
                    <CollectionFieldset dp={dp} dc={dc} onChange={handleAutoFix} />

                    {type !== "" && <div>
                        {isEntity(type) &&
                            <ValueComponent dc={dc} labelColumns={5} binding={Binding.create(dp, d => d.isLite)}
                                type="boolean" defaultValue={null} onChange={handleAutoFix} />}

                        {allowsSize(type) &&
                            <ValueComponent dc={dc} labelColumns={5} binding={Binding.create(dp, d => d.size)}
                                type="number" defaultValue={null} onBlur={handleAutoFix} />}

                        {isDecimal(type) &&
                            <ValueComponent dc={dc} labelColumns={5} binding={Binding.create(dp, d => d.scale)}
                                type="number" defaultValue={null} onBlur={handleAutoFix} />}

                        <ValueComponent dc={dc} labelColumns={5} binding={Binding.create(dp, d => d.uniqueIndex)}
                            type="string" defaultValue={"No"} avoidDelete options={DynamicUniqueIndexValues} />
                    </div>}
                </div>
            </div>

            <br />
            <ValueComponent dc={dc} labelColumns={3} binding={Binding.create(dp, d => d.customFieldAttributes)}
                type="string" defaultValue={null} onBlur={handleAutoFix} />
            <ValueComponent dc={dc} labelColumns={3} binding={Binding.create(dp, d => d.customPropertyAttributes)}
                type="string" defaultValue={null} onBlur={handleAutoFix} />

            <ValidatorRepeaterComponent dc={dc} property={dp} />
        </div>
    );
}

/** Signum's `TypeCombo` — a text box with the value types offered; see the header on autocomplete. */
export function TypeCombo(p: {
    dc: DynamicTypeDesignContext;
    binding: Binding<string>;
    labelColumns: number;
    onBlur: () => void;
}): React.JSX.Element {
    return (
        <div className="form-group form-group-sm row">
            <label className={"col-form-label col-form-label-sm col-sm-" + p.labelColumns}>
                {p.binding.member}
            </label>
            <div className={"col-sm-" + (12 - p.labelColumns)}>
                <input className="form-control form-control-sm" list="dynamic-type-values" type="text"
                    value={p.binding.getValue() ?? ""} onBlur={p.onBlur}
                    onChange={e => { p.binding.setValue(e.currentTarget.value); p.dc.refreshView(); }} />
                <datalist id="dynamic-type-values">
                    {valueTypes.map(t => <option key={t} value={t} />)}
                </datalist>
            </div>
        </div>
    );
}

/**
 * Signum's `IsMListFieldsetComponent` — present/absent decides whether the property is a COLLECTION.
 *
 * Labelled "collection", because that is what it produces in altea: a generated `@part` row type. The
 * stored key stays `isMList` so a definition round-trips with Signum.
 */
function CollectionFieldset(p: {
    dp: DynamicProperty;
    dc: DynamicTypeDesignContext;
    onChange: () => void;
}): React.JSX.Element {
    const dp = p.dp;
    const present = dp.isMList != null;

    return (
        <fieldset>
            <legend>
                <input type="checkbox" className="form-check-input me-2" checked={present}
                    onChange={() => {
                        dp.isMList = present ? undefined : { preserveOrder: true };
                        p.onChange();
                        p.dc.refreshView();
                    }} />
                Is collection
            </legend>
            {dp.isMList != null &&
                <div className="database-mapping">
                    <ValueComponent dc={p.dc} labelColumns={4} type="boolean" defaultValue={null}
                        binding={Binding.create(dp.isMList, d => d.preserveOrder)} />
                    <ValueComponent dc={p.dc} labelColumns={4} type="string" defaultValue={null}
                        binding={Binding.create(dp.isMList, d => d.orderName)} />
                    <ValueComponent dc={p.dc} labelColumns={4} type="string" defaultValue={null}
                        binding={Binding.create(dp.isMList, d => d.tableName)} />
                    <ValueComponent dc={p.dc} labelColumns={4} type="string" defaultValue={null}
                        binding={Binding.create(dp.isMList, d => d.backReferenceName)} />
                </div>}
        </fieldset>
    );
}

// ---- validators ----------------------------------------------------------------------------------------

/**
 * Signum's validator registry (`registerValidator<T>`), flattened.
 *
 * There, each validator is a class plus a registration carrying its render function and an `isApplicable`
 * predicate. Here a validator IS its option bag (the discriminated union in data/DynamicType), so a
 * registration is just "which options, and when does this validator apply" — and the editor renders the
 * options generically.
 */
interface ValidatorDescriptor {
    type: string;
    /** Which option keys the editor offers, and how to edit each. */
    options?: Array<{ name: string; type: "number" | "string" | "boolean"; options?: (string | number)[] }>;
    isApplicable?: (dp: DynamicProperty) => boolean;
}

export const validators: ValidatorDescriptor[] = [
    { type: "NotNull", options: [{ name: "disabled", type: "boolean" }] },
    {
        type: "StringLength",
        isApplicable: dp => isString(dp.type ?? ""),
        options: [
            { name: "multiLine", type: "boolean" },
            { name: "min", type: "number" },
            { name: "max", type: "number" },
            { name: "allowLeadingSpaces", type: "boolean" },
            { name: "allowTrailingSpaces", type: "boolean" },
        ],
    },
    {
        type: "Decimals",
        isApplicable: dp => isReal(dp.type ?? ""),
        options: [{ name: "decimalPlaces", type: "number" }],
    },
    {
        type: "NumberIs",
        isApplicable: dp => isInteger(dp.type ?? "") || isReal(dp.type ?? ""),
        options: [
            { name: "comparisonType", type: "string", options: ["EqualTo", "DistinctTo", "GreaterThan", "GreaterThanOrEqualTo", "LessThan", "LessThanOrEqualTo"] },
            { name: "number", type: "number" },
        ],
    },
    {
        type: "NumberBetween",
        isApplicable: dp => isInteger(dp.type ?? "") || isReal(dp.type ?? ""),
        options: [{ name: "min", type: "number" }, { name: "max", type: "number" }],
    },
    {
        type: "CountIs",
        isApplicable: dp => dp.isMList != null,
        options: [
            { name: "comparisonType", type: "string", options: ["EqualTo", "DistinctTo", "GreaterThan", "GreaterThanOrEqualTo", "LessThan", "LessThanOrEqualTo"] },
            { name: "number", type: "number" },
        ],
    },
    {
        type: "StringCase",
        isApplicable: dp => isString(dp.type ?? ""),
        options: [{ name: "textCase", type: "string", options: ["UpperCase", "LowerCase"] }],
    },
    { type: "URL", isApplicable: dp => isString(dp.type ?? "") },
    { type: "EMail", isApplicable: dp => isString(dp.type ?? "") },
    { type: "Telephone", isApplicable: dp => isString(dp.type ?? "") },
    { type: "NoRepeat", isApplicable: dp => dp.isMList != null },
];

export function ValidatorRepeaterComponent(p: {
    dc: DynamicTypeDesignContext;
    property: DynamicProperty;
}): React.JSX.Element {
    const dp = p.property;
    const list = dp.validators ??= [];

    const applicable = validators.filter(v => v.isApplicable?.(dp) ?? true);

    function add(type: string): void {
        const descriptor = validators.find(v => v.type === type);
        list.push({ type, ...(descriptor?.type === "NumberIs" || descriptor?.type === "CountIs"
            ? { comparisonType: "EqualTo", number: 0 } : {}) } as DynamicValidator);
        p.dc.refreshView();
    }

    return (
        <fieldset>
            <legend>Validators</legend>
            {list.map((v, i) =>
                <div className="row align-items-center mb-1" key={i}>
                    <div className="col-auto">
                        <LinkButton className={classes("sf-line-button", "sf-remove")}
                            onClick={e => { e.preventDefault(); list.splice(i, 1); p.dc.refreshView(); }}
                            title={EntityControlMessage.Remove.niceToString()}>
                            <FontAwesomeIcon aria-hidden={true} icon="xmark" />
                        </LinkButton>
                    </div>
                    <div className="col-auto"><strong>{v.type}</strong></div>
                    {(validators.find(d => d.type === v.type)?.options ?? []).map(o =>
                        <div className="col-auto" key={o.name}>
                            <label className="col-form-label col-form-label-sm me-1">{o.name}</label>
                            <ValueComponent dc={p.dc} hideLabel type={o.type} options={o.options}
                                defaultValue={null} binding={new Binding(v as object, o.name)} />
                        </div>)}
                </div>)}

            <select className="form-control form-control-sm mt-2" value=""
                onChange={e => { if (e.currentTarget.value !== "") add(e.currentTarget.value); }}>
                <option value="">{" - "}</option>
                {applicable.map(v => <option key={v.type} value={v.type}>{v.type}</option>)}
            </select>
        </fieldset>
    );
}
