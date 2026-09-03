import * as React from "react";
import { Tab, Tabs } from "react-bootstrap";
import { Binding } from "@altea/altea/client/binding";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import { EntityControlMessage } from "@altea/altea/data/uiMessages";
import TypeScriptCodeMirror from "@altea/altea-codemirror/client/TypeScriptCodeMirror";
import ValueComponent, { type DynamicTypeDesignContext } from "./ValueComponent";
import { PropertyRepeaterComponent } from "./PropertyRepeaterComponent";
import {
    DynamicBaseType, DynamicTypeMessage,
    type DynamicTypeDefinition, type DynamicProperty, type DynamicTypeEntity,
} from "../../data/DynamicType";

// Port of Signum.Dynamic's Type/DynamicTypeDefinitionComponent.tsx — the tabs of the type designer
// (properties, query, operations, custom code) plus the optional database-mapping fieldsets.
//
// The PROPERTY half lives in ./PropertyRepeaterComponent (Signum keeps all of it in one file — see that
// file's header).
//
// altea divergences:
//  - **the QUERY tab lists MEMBER names, not `e.Id`-style expressions.** Signum's query fields are C#
//    projection lines (`e.Id`, `Total = e.Lines.Sum(...)`), because its `WithQuery` takes an anonymous
//    projection. altea's server `withQuery()` takes none — a query's shape is the entity — and which
//    columns a search shows by default is a CLIENT setting. So a query field here is simply a property
//    name, and DynamicTypeLogic notes the same thing.
//  - Signum's `expressionNames` fetch (offer this type's registered expressions as query fields) has no
//    counterpart for the same reason: nothing on the server consumes them.
//  - the operations tab edits BODIES ONLY. Signum's is the same, except that it renders C#; here the four
//    blocks are TypeScript and their signatures name what the generator actually emits.
//  - `CSharpExpressionCodeMirror` becomes `ExpressionCodeMirror` over TypeScript.
//  - `TypeHelpComponent` / the "property template" modal are not ported (TypeHelp is not — the honest
//    equivalent is editor IntelliSense over the same `.d.ts`).

export interface DynamicTypeDefinitionComponentProps {
    dynamicType: DynamicTypeEntity;
    definition: DynamicTypeDefinition;
    dc: DynamicTypeDesignContext;
    showDatabaseMapping: boolean;
}

/** Signum's `requiresSaveKinds` — which entity kinds must declare a Save operation. */
const requiresSaveKinds = ["Main", "Shared", "String"];

const entityKindValues = ["SystemString", "System", "Relational", "String", "Shared", "Main", "Part", "SharedPart"];
const entityDataValues = ["Master", "Transactional"];

export function DynamicTypeDefinitionComponent(p: DynamicTypeDefinitionComponentProps): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const def = p.definition;
    const dt = p.dynamicType;
    const isEntity = dt.baseType === DynamicBaseType.Entity;

    React.useEffect(() => {
        if (dt.isNew)
            void fixSaveOperation();
    }, []);

    /**
     * Signum's `fixSaveOperation` — a kind that requires a Save gets one, and a kind that does not loses
     * one (asking first, if a body would be thrown away).
     *
     * Worth keeping honest: the GENERATOR throws when the two disagree (see
     * DynamicTypeCodeGenerator.getEntityOperation), so this is the editor saving the author from a compile
     * error rather than a nicety.
     */
    async function fixSaveOperation(): Promise<void> {
        const requiresSave = isEntity && def.entityKind != null && requiresSaveKinds.includes(def.entityKind);

        if (requiresSave && def.operationSave == null) {
            def.operationSave = { execute: "" };
            forceUpdate();
            return;
        }

        if (!requiresSave && def.operationSave != null) {
            const empty = !def.operationSave.execute && !def.operationSave.canExecute;
            if (empty) {
                def.operationSave = undefined;
                forceUpdate();
                return;
            }

            const answer = await MessageModal.show({
                title: EntityControlMessage.Remove.niceToString(),
                message: DynamicTypeMessage.RemoveSaveOperation.niceToString(),
                buttons: "yes_no",
                icon: "question",
            });

            if (answer === "yes") {
                def.operationSave = undefined;
                forceUpdate();
            }
        }
    }

    function handlePropertyRemoved(dp: DynamicProperty): void {
        // Signum's handlePropertyRemoved: a removed property cannot stay a query field.
        def.queryFields = (def.queryFields ?? []).filter(f => f !== dp.name);
        p.dc.refreshView();
    }

    const suffix = dt.baseType === DynamicBaseType.MixinEntity ? "Mixin"
        : dt.baseType === DynamicBaseType.EmbeddedEntity ? "Embedded"
            : dt.baseType === DynamicBaseType.ModelEntity ? "Model" : "Entity";

    const typeName = (dt.typeName ?? "") + suffix;

    return (
        <div>
            {isEntity &&
                <div>
                    {p.showDatabaseMapping &&
                        <ValueComponent dc={p.dc} labelColumns={2} type="string" defaultValue={null}
                            labelClass="database-mapping" binding={Binding.create(def, d => d.tableName)} />}

                    <div className="row">
                        <div className="col-sm-6">
                            <ValueComponent dc={p.dc} labelColumns={4} type="string" defaultValue={null}
                                options={entityKindValues} onChange={() => { void fixSaveOperation(); }}
                                binding={Binding.create(def, d => d.entityKind)} />
                        </div>
                        <div className="col-sm-6">
                            <ValueComponent dc={p.dc} labelColumns={4} type="string" defaultValue={null}
                                options={entityDataValues} binding={Binding.create(def, d => d.entityData)} />
                        </div>
                    </div>

                    {p.showDatabaseMapping &&
                        <div className="row database-mapping">
                            <div className="col-sm-6">
                                <OptionalFieldset title="Primary Key" binding={Binding.create(def, d => d.primaryKey)}
                                    dc={p.dc} onCreate={() => ({ name: "Id", type: "int", identity: true })}
                                    renderContent={item =>
                                        <div>
                                            <ValueComponent dc={p.dc} labelColumns={4} type="string" defaultValue={null}
                                                binding={Binding.create(item, i => i.name)} />
                                            <ValueComponent dc={p.dc} labelColumns={4} type="string" defaultValue={null}
                                                options={["int", "long", "uuid", "uuid7"]}
                                                binding={Binding.create(item, i => i.type)} />
                                            <ValueComponent dc={p.dc} labelColumns={4} type="boolean" defaultValue={null}
                                                binding={Binding.create(item, i => i.identity)} />
                                        </div>} />
                            </div>
                            <div className="col-sm-6">
                                <OptionalFieldset title="Ticks" binding={Binding.create(def, d => d.ticks)}
                                    dc={p.dc} onCreate={() => ({ hasTicks: false })}
                                    renderContent={item =>
                                        <div>
                                            <ValueComponent dc={p.dc} labelColumns={4} type="boolean" defaultValue={null}
                                                binding={Binding.create(item, i => i.hasTicks)} />
                                        </div>} />
                            </div>
                        </div>}
                </div>}

            <Tabs defaultActiveKey="properties" id="DynamicTypeTabs" mountOnEnter>
                <Tab eventKey="properties" title="Properties">
                    <PropertyRepeaterComponent dc={p.dc} properties={def.properties}
                        onRemove={handlePropertyRemoved} showDatabaseMapping={p.showDatabaseMapping} />
                    <br />

                    {isEntity &&
                        <OptionalFieldset title="Multi-Column Unique Index" dc={p.dc}
                            binding={Binding.create(def, d => d.multiColumnUniqueIndex)}
                            onCreate={() => ({ fields: [] })}
                            renderContent={item =>
                                <div className="row">
                                    <div className="col-sm-6">
                                        <StringListComponent dc={p.dc} list={item.fields}
                                            options={def.properties.filter(a => a.isMList == null).map(a => a.name)} />
                                    </div>
                                    <div className="col-sm-6">
                                        <ExpressionCodeMirror dc={p.dc} title="Where"
                                            signature={"(e: " + typeName + ") =>"}
                                            binding={Binding.create(item, i => i.where)} />
                                    </div>
                                </div>} />}

                    <fieldset>
                        <legend>toString expression</legend>
                        <ExpressionCodeMirror dc={p.dc} signature={"(this: " + typeName + ") =>"}
                            binding={Binding.create(def, d => d.toStringExpression)} />
                    </fieldset>
                </Tab>

                {isEntity &&
                    <Tab eventKey="query" title="Query">
                        {/* Member NAMES, not projection lines — see the header. */}
                        <StringListComponent dc={p.dc} list={def.queryFields ??= []}
                            options={def.properties.map(a => a.name)} />
                    </Tab>}

                {isEntity &&
                    <Tab eventKey="operations" title="Operations">
                        <OptionalFieldset title="Save" dc={p.dc} binding={Binding.create(def, d => d.operationSave)}
                            onCreate={() => ({ execute: "", canExecute: undefined })}
                            renderContent={item =>
                                <div>
                                    <ExpressionCodeMirror dc={p.dc} title="CanExecute"
                                        signature={"(e: " + typeName + ") => string | null"}
                                        binding={Binding.create(item, i => i.canExecute)} />
                                    <ExpressionCodeMirror dc={p.dc} title="Execute"
                                        signature={"(e: " + typeName + ", args) =>"}
                                        binding={Binding.create(item, i => i.execute)} />
                                </div>} />

                        <OptionalFieldset title="Delete" dc={p.dc} binding={Binding.create(def, d => d.operationDelete)}
                            onCreate={() => ({ delete: "", canDelete: undefined })}
                            renderContent={item =>
                                <div>
                                    <ExpressionCodeMirror dc={p.dc} title="CanDelete"
                                        signature={"(e: " + typeName + ") => string | null"}
                                        binding={Binding.create(item, i => i.canDelete)} />
                                    <ExpressionCodeMirror dc={p.dc} title="Delete"
                                        signature={"(e: " + typeName + ", args) =>"}
                                        binding={Binding.create(item, i => i.delete)} />
                                </div>} />

                        <OptionalFieldset title="Create" dc={p.dc} binding={Binding.create(def, d => d.operationCreate)}
                            onCreate={() => ({ construct: "" })}
                            renderContent={item =>
                                <ExpressionCodeMirror dc={p.dc} title="Construct" signature="(args) =>"
                                    binding={Binding.create(item, i => i.construct)} />} />

                        <OptionalFieldset title="Clone" dc={p.dc} binding={Binding.create(def, d => d.operationClone)}
                            onCreate={() => ({ construct: "", canConstruct: undefined })}
                            renderContent={item =>
                                <div>
                                    <ExpressionCodeMirror dc={p.dc} title="CanConstruct"
                                        signature={"(e: " + typeName + ") => string | null"}
                                        binding={Binding.create(item, i => i.canConstruct)} />
                                    <ExpressionCodeMirror dc={p.dc} title="Construct"
                                        signature={"(e: " + typeName + ", args) =>"}
                                        binding={Binding.create(item, i => i.construct)} />
                                </div>} />
                    </Tab>}

                <Tab eventKey="customCode" title="Custom Code">
                    <CustomCodeTab definition={def} dc={p.dc} typeName={typeName} />
                </Tab>
            </Tabs>
        </div>
    );
}

/** Signum's CustomCodeTab — the six verbatim blocks spliced into the generated modules. */
export function CustomCodeTab(p: {
    definition: DynamicTypeDefinition;
    dc: DynamicTypeDesignContext;
    typeName: string;
}): React.JSX.Element {
    const def = p.definition;

    const blocks: Array<{ title: string; hint: string; binding: Binding<{ code: string } | undefined> }> = [
        { title: "Custom Inheritance", hint: "The base class expression, e.g. TreeEntity", binding: Binding.create(def, d => d.customInheritance) },
        { title: "Custom Entity Members", hint: "Members added to the generated entity class", binding: Binding.create(def, d => d.customEntityMembers) },
        { title: "Custom Start Code", hint: "Statements added to the generated Logic.start(sb)", binding: Binding.create(def, d => d.customStartCode) },
        { title: "Custom Logic Members", hint: "Members added to the generated Logic namespace", binding: Binding.create(def, d => d.customLogicMembers) },
        { title: "Custom Types", hint: "Extra declarations added to the generated entity module", binding: Binding.create(def, d => d.customTypes) },
        { title: "Custom Before Schema", hint: "Statements run BEFORE the schema is built", binding: Binding.create(def, d => d.customBeforeSchema) },
    ];

    return (
        <div>
            {blocks.map(b =>
                <OptionalFieldset key={b.title} title={b.title} dc={p.dc} binding={b.binding}
                    onCreate={() => ({ code: "" })}
                    renderContent={item =>
                        <div>
                            <small className="text-muted">{b.hint}</small>
                            <ExpressionCodeMirror dc={p.dc} binding={Binding.create(item, i => i.code)} />
                        </div>} />)}
        </div>
    );
}

/**
 * Signum's `CustomFieldsetComponent` — a fieldset whose CHECKBOX decides whether the bound value exists at
 * all, which is how an optional part of the definition is added or removed.
 */
export function OptionalFieldset<T>(p: {
    title: string;
    dc: DynamicTypeDesignContext;
    binding: Binding<T | undefined>;
    onCreate: () => T;
    renderContent: (item: T) => React.ReactNode;
}): React.JSX.Element {
    const value = p.binding.getValue();

    return (
        <fieldset>
            <legend>
                <input type="checkbox" className="form-check-input me-2" checked={value != null}
                    onChange={() => {
                        if (value == null)
                            p.binding.setValue(p.onCreate());
                        else
                            p.binding.deleteValue();
                        p.dc.refreshView();
                    }} />
                {p.title}
            </legend>
            {value != null && p.renderContent(value)}
        </fieldset>
    );
}

/** Signum's CSharpExpressionCodeMirror, over TypeScript. */
export function ExpressionCodeMirror(p: {
    dc: DynamicTypeDesignContext;
    binding: Binding<string | undefined>;
    title?: string;
    signature?: string;
}): React.JSX.Element {
    return (
        <div className="mb-2">
            {p.title != null && <small className="d-block">{p.title}</small>}
            {p.signature != null && <pre className="mb-1"><small>{p.signature}</small></pre>}
            <div className="code-container">
                <TypeScriptCodeMirror code={p.binding.getValue() ?? ""}
                    onChange={code => { p.binding.setValue(code); p.dc.refreshView(); }} />
            </div>
        </div>
    );
}

/** Signum's ComboBoxRepeaterComponent — an ordered list of strings picked from a fixed set. */
export function StringListComponent(p: {
    dc: DynamicTypeDesignContext;
    list: string[];
    options: string[];
}): React.JSX.Element {
    const remaining = p.options.filter(o => !p.list.includes(o));

    return (
        <div>
            {p.list.map((item, i) =>
                <div className="row align-items-center mb-1" key={i}>
                    <div className="col-auto">
                        <button type="button" className="btn btn-sm btn-link p-0"
                            onClick={() => { p.list.splice(i, 1); p.dc.refreshView(); }}
                            title={EntityControlMessage.Remove.niceToString()}>✕</button>
                    </div>
                    <div className="col-auto">{item}</div>
                </div>)}

            {remaining.length > 0 &&
                <select className="form-control form-control-sm mt-1" value=""
                    onChange={e => {
                        if (e.currentTarget.value !== "") {
                            p.list.push(e.currentTarget.value);
                            p.dc.refreshView();
                        }
                    }}>
                    <option value="">{" - "}</option>
                    {remaining.map(o => <option key={o} value={o}>{o}</option>)}
                </select>}
        </div>
    );
}
