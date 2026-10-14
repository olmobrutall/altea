import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "@altea/altea/data/globals/helpers";
import type { MonacoEditor } from "@altea/altea-monaco/client/MonacoComponent";
import type { Monaco } from "@altea/altea-monaco/client/monaco";
import { syntaxContextAt, type ClassInfo, type DecoratorInfo, type MemberInfo, type Span, type SyntaxContext } from "@altea/altea-monaco/client/syntaxContext";
import { Typeahead, type TextHighlighter } from "@altea/altea/client/Components/Typeahead";
import { getRegisteredEnums, getRegisteredTypes } from "@altea/altea/data/registration";
import { EmbeddedEntity, Entity, ModelEntity } from "@altea/altea/data/entity";
import { isPartType } from "@altea/altea/data/propertyRoute";
import { DynamicTypeRecipeMessage as M } from "../../data/DynamicType";

// RECIPES: small editors beside the data module, for whatever the cursor is on. The SOURCE stays the only
// truth — every change here is a text edit through the editor (so it is undoable, and the author sees it
// land), computed from the spans the TypeScript worker reports (altea-monaco's `alteaSyntaxContext`).
//
//  - on a FIELD: its name (renamed everywhere; the next migration asks whether it was a rename), type
//    (any value type or schema type), nullability, Lite, unique index, unit / format, validators, and
//    turning it into a collection — under a link to its CLASS;
//  - on a CLASS: add a field, a collection (with its `@part` row) or a toString;
//  - inside the OPERATIONS (`<Name>Operation` in the data module, `<Name>Logic.start` in the server one):
//    declared in the first, registered in the second — adding one does both.

/** The value types a member can be declared with, besides a registered entity / embedded / enum. */
const valueTypes = [
    "string", "boolean", "number", "short", "int", "long", "float", "Decimal", "uuid",
    "Temporal.PlainDate", "Temporal.PlainDateTime", "Temporal.PlainTime", "Temporal.Duration", "Uint8Array",
];

const numericTypes = ["number", "short", "int", "long", "float", "Decimal"];
const dateTypes = ["Temporal.PlainDate", "Temporal.PlainDateTime"];

interface ValidatorRecipe {
    name: string;
    /** What goes between the parentheses of a new one. */
    args: string;
    appliesTo: (base: string, array: boolean) => boolean;
}

const validatorRecipes: ValidatorRecipe[] = [
    { name: "notNullValidator", args: "", appliesTo: () => true },
    { name: "stringLengthValidator", args: "{ max: 100 }", appliesTo: (b, a) => !a && b === "string" },
    { name: "stringCaseValidator", args: "StringCase.Uppercase", appliesTo: (b, a) => !a && b === "string" },
    { name: "emailValidator", args: "", appliesTo: (b, a) => !a && b === "string" },
    { name: "urlValidator", args: "", appliesTo: (b, a) => !a && b === "string" },
    { name: "telephoneValidator", args: "", appliesTo: (b, a) => !a && b === "string" },
    { name: "decimalsValidator", args: "2", appliesTo: (b, a) => !a && ["number", "float", "Decimal"].includes(b) },
    { name: "numberIsValidator", args: "ComparisonType.GreaterThan, 0", appliesTo: (b, a) => !a && numericTypes.includes(b) },
    { name: "numberBetweenValidator", args: "0, 100", appliesTo: (b, a) => !a && numericTypes.includes(b) },
    { name: "dateInPastValidator", args: "", appliesTo: (b, a) => !a && dateTypes.includes(b) },
    { name: "dateInFutureValidator", args: "", appliesTo: (b, a) => !a && dateTypes.includes(b) },
    { name: "countIsValidator", args: "ComparisonType.GreaterThan, 0", appliesTo: (_b, a) => a },
    { name: "noRepeatValidator", args: "", appliesTo: (_b, a) => a },
];

interface Edit {
    span: Span;
    text: string;
}

type TypeKind = "value" | "entity" | "embedded" | "enum" | "model";

/** A type a member can be declared with — what the type box offers. */
interface KnownType {
    name: string;
    kind: TypeKind;
}

/** The syntax context with the offset it was asked at. */
type CursorContext = SyntaxContext & { offset: number };

export interface DynamicTypeRecipesProps {
    /** Which module this panel sits beside. */
    side: "data" | "server";
    typeName: string;
    monaco: Monaco | null;
    dataEditor: MonacoEditor | null;
    serverEditor: MonacoEditor | null;
}

export function DynamicTypeRecipes(p: DynamicTypeRecipesProps): React.JSX.Element {
    const followed = p.side === "data" ? p.dataEditor : p.serverEditor;
    const context = useSyntaxContext(p.monaco, followed, true);
    // The OTHER module, read whole: operations are declared in one and registered in the other.
    const other = useSyntaxContext(p.monaco, p.side === "data" ? p.serverEditor : p.dataEditor, false);
    const dataCtx = p.side === "data" ? context : other;
    const serverCtx = p.side === "server" ? context : other;
    const knownTypes = useKnownTypes(dataCtx);

    const applyData = (edits: Edit[]): void => applyEdits(p.monaco, p.dataEditor, edits);
    const applyServer = (edits: Edit[]): void => applyEdits(p.monaco, p.serverEditor, edits);

    /**
     * Rename a symbol EVERYWHERE it is used — `this.name` in toString, `e.name` in the server module —
     * asking the language service, which sees both modules.
     */
    async function rename(position: number, newName: string): Promise<void> {
        const model = p.dataEditor?.getModel();
        const monaco = p.monaco;
        if (model == null || monaco == null)
            return;

        const worker = await monaco.languages.typescript.getTypeScriptWorker();
        const client = await worker(model.uri);
        const locations = await client.findRenameLocations(model.uri.toString(), position, false, false, false) ?? [];

        const byFile = new Map<string, Edit[]>();
        for (const l of locations as Array<{ fileName: string; textSpan: { start: number; length: number } }>) {
            let edits = byFile.get(l.fileName);
            if (edits == null)
                byFile.set(l.fileName, edits = []);
            edits.push({ span: { start: l.textSpan.start, end: l.textSpan.start + l.textSpan.length }, text: newName });
        }

        for (const [fileName, edits] of byFile) {
            const editor = [p.dataEditor, p.serverEditor].find(e => e?.getModel()?.uri.toString() === fileName);
            if (editor != null)
                applyEdits(monaco, editor, edits);
        }
    }

    const offset = context?.offset ?? -1;
    const inside = (span: Span | undefined): boolean => span != null && span.start <= offset && offset <= span.end;

    const container = p.typeName + "Operation";
    const operationsBlock = dataCtx?.namespaces.find(n => n.name === container);
    const start = serverCtx?.namespaces.find(n => n.name === p.typeName + "Logic")
        ?.members.find(m => m.kind === "function" && m.name === "start");

    const operations = dataCtx != null && serverCtx != null &&
        <OperationsRecipe typeName={p.typeName} dataCtx={dataCtx} serverCtx={serverCtx}
            serverText={() => p.serverEditor?.getModel()?.getValue() ?? ""}
            applyData={applyData} applyServer={applyServer} />;

    if (p.side === "server")
        return inside(start)
            ? <div className="text-[.875em]">{operations}</div>
            : <Hint text={M.PlaceTheCursorInside0.niceToString(p.typeName + "Logic.start")} />;

    if (inside(operationsBlock))
        return <div className="text-[.875em]">{operations}</div>;

    const member = context?.member?.kind === "property" ? context.member : undefined;
    const cls = context?.class;

    if (cls == null)
        return <Hint text={M.PlaceTheCursorOnAClassOrAField.niceToString()} />;

    if (member != null)
        return (
            <div className="text-[.875em]">
                <div className="text-h6 font-medium mb-2">
                    <a href="#" onClick={e => { e.preventDefault(); goTo(p.dataEditor, cls.nameSpan.start); }}>
                        {M.Class.niceToString()}: <code>{cls.name}</code>
                    </a>
                </div>
                <div className="ms-4">
                    <FieldRecipe key={cls.name + "." + member.name} cls={cls} member={member}
                        knownTypes={knownTypes} apply={applyData} rename={rename}
                        removeDecorator={d => removeDecorator(p.dataEditor, d)} />
                </div>
            </div>
        );

    /** An empty `<Name>Operation` after the last class, with the cursor in it — so the operations show. */
    function addOperationsBlock(): void {
        const at = dataCtx?.classes.at(-1)?.end ?? 0;
        const text = `

export namespace ${container} {
}`;
        applyData([{ span: { start: at, end: at }, text }]);
        goTo(p.dataEditor, at + text.length - 1);
    }

    return (
        <div className="text-[.875em]">
            <ClassRecipe cls={cls} knownTypes={knownTypes} apply={applyData} />
            {cls.name === p.typeName + "Entity" && (operationsBlock != null
                ? <a href="#" onClick={e => { e.preventDefault(); goTo(p.dataEditor, operationsBlock.bodyStart); }}>
                    <FontAwesomeIcon aria-hidden={true} icon="bolt" /> {M.EditOperations.niceToString()}
                </a>
                : <button type="button" className="btn btn-sm btn-outline-secondary" onClick={addOperationsBlock}>
                    <FontAwesomeIcon aria-hidden={true} icon="bolt" /> {M.AddOperations.niceToString()}
                </button>)}
        </div>
    );
}

function Hint(p: { text: string }): React.JSX.Element {
    return <div className="text-muted-foreground text-[.875em] p-2">{p.text}</div>;
}

/** Put the cursor at `offset` and the focus in the editor — which moves the recipes along with it. */
function goTo(editor: MonacoEditor | null, offset: number): void {
    const model = editor?.getModel();
    if (editor == null || model == null)
        return;
    const position = model.getPositionAt(offset);
    editor.setPosition(position);
    editor.revealPositionInCenterIfOutsideViewport(position);
    editor.focus();
}

/** The worker's view of `editor`'s model — at the cursor when `followCursor`, else the whole file. */
function useSyntaxContext(monaco: Monaco | null, editor: MonacoEditor | null, followCursor: boolean): CursorContext | null {
    const [context, setContext] = React.useState<CursorContext | null>(null);

    // Follow the cursor, and the text: an edit (ours or the author's) moves every span.
    React.useEffect(() => {
        if (editor == null || monaco == null)
            return;

        let handle: ReturnType<typeof setTimeout> | undefined;
        let alive = true;
        const refresh = (): void => {
            clearTimeout(handle);
            handle = setTimeout(() => void (async () => {
                const model = editor.getModel();
                const position = editor.getPosition();
                if (model == null)
                    return;
                const offset = followCursor && position != null ? model.getOffsetAt(position) : 0;
                const result = await syntaxContextAt(monaco, model, offset);
                if (alive)
                    setContext(result == null ? null : { ...result, offset });
            })(), 250);
        };

        refresh();
        const subscriptions = [editor.onDidChangeModelContent(refresh), ...followCursor ? [editor.onDidChangeCursorPosition(refresh)] : []];
        return () => { alive = false; clearTimeout(handle); subscriptions.forEach(s => s.dispose()); };
    }, [monaco, editor, followCursor]);

    return context;
}

/** Edits as ONE undoable step of `editor` — so the author can take back a recipe with Ctrl+Z. */
function applyEdits(monaco: Monaco | null, editor: MonacoEditor | null, edits: Edit[]): void {
    const model = editor?.getModel();
    if (monaco == null || editor == null || model == null || edits.length === 0)
        return;

    editor.pushUndoStop();
    editor.executeEdits("altea-recipe", edits.map(e => {
        const start = model.getPositionAt(e.span.start);
        const end = model.getPositionAt(e.span.end);
        return { range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: e.text };
    }));
    editor.pushUndoStop();
}

/** A decorator removed with the whitespace after it, so no empty line is left behind. */
function removeDecorator(editor: MonacoEditor | null, d: DecoratorInfo): Edit {
    const text = editor?.getModel()?.getValue() ?? "";
    let end = d.end;
    while (end < text.length && /\s/.test(text[end]))
        end++;
    return { span: { start: d.start, end }, text: "" };
}

// ---- a field ---------------------------------------------------------------------------------------------

function FieldRecipe(p: {
    cls: ClassInfo;
    member: MemberInfo;
    knownTypes: KnownType[];
    apply: (edits: Edit[]) => void;
    rename: (position: number, newName: string) => Promise<void>;
    removeDecorator: (d: DecoratorInfo) => Edit;
}): React.JSX.Element {
    const m = p.member;
    const shape = m.typeShape;
    const decorator = (name: string): DecoratorInfo | undefined => m.decorators.find(d => d.name === name);

    /** A new decorator on its own line above the member. */
    function addDecorator(text: string): Edit {
        return { span: { start: m.lineStart, end: m.lineStart }, text: `${m.indent}@${text}\n` };
    }

    function setType(next: { base: string; lite: boolean; array: boolean; nullable: boolean }): void {
        if (m.typeSpan == null)
            return;
        const type = (next.lite ? `Lite<${next.base}>` : next.base) + (next.array ? "[]" : "") + (next.nullable ? " | null" : "");
        const edits: Edit[] = [{ span: m.typeSpan, text: type }];

        // A binary member is an `accessor` with an initializer, as every altea Uint8Array is — and stops being
        // one when it changes to anything else.
        const binary = next.base === "Uint8Array" && !next.array;
        const defaultInitializers = ["null", "new Uint8Array(0)"];
        if (binary) {
            const initializer = next.nullable ? "null" : "new Uint8Array(0)";
            if (!m.accessor)
                edits.push({ span: { start: m.nameSpan.start, end: m.nameSpan.start }, text: "accessor " });
            if (m.initializerSpan == null)
                edits.push({ span: { start: m.typeSpan.end, end: m.typeSpan.end }, text: " = " + initializer });
            else if (defaultInitializers.includes(m.initializerText ?? ""))
                edits.push({ span: m.initializerSpan, text: initializer });
        } else if (m.accessorSpan != null) {
            edits.push({ span: { start: m.accessorSpan.start, end: m.nameSpan.start }, text: "" });
            if (m.initializerSpan != null && defaultInitializers.includes(m.initializerText ?? ""))
                edits.push({ span: { start: m.typeSpan.end, end: m.initializerSpan.end }, text: "" });
        }
        p.apply(edits);
    }

    function toggleDecorator(name: string, on: boolean, text: string = name): void {
        const existing = decorator(name);
        if (on && existing == null)
            p.apply([addDecorator(text)]);
        else if (!on && existing != null)
            p.apply([p.removeDecorator(existing)]);
    }

    /** `@unit("kg")`: set, change or (empty) remove the one string argument. */
    function setStringDecorator(name: string, value: string): void {
        const existing = decorator(name);
        const literal = JSON.stringify(value);
        if (value === "")
            existing != null && p.apply([p.removeDecorator(existing)]);
        else if (existing?.argsSpan != null)
            p.apply([{ span: existing.argsSpan, text: literal }]);
        else if (existing == null)
            p.apply([addDecorator(`${name}(${literal})`)]);
    }

    const validators = m.decorators.filter(d => d.name.endsWith("Validator"));
    /** A validator the type no longer fits (`stringLength` on a Decimal). Unknown ones are given the benefit. */
    const applies = (name: string): boolean => {
        const recipe = validatorRecipes.find(r => r.name === name);
        return recipe == null || shape == null || recipe.appliesTo(shape.base, shape.array);
    };
    const available = shape == null ? [] : validatorRecipes.filter(v => v.appliesTo(shape.base, shape.array) && decorator(v.name) == null);

    const isEntity = shape != null && typeKindOf(shape.base, p.knownTypes) === "entity";
    /** A collection ROW: one of its members is the back reference to the owner, another the collection's value. */
    const isPart = p.cls.decorators.some(d => d.name === "part");
    /** A row that already belongs to a collection (it has its back reference): no collections inside it. */
    const isCollectionRow = isPart && p.cls.members.some(f => f.decorators.some(d => d.name === "backReference"));

    /**
     * `name: T` → `name: Owner_Name[]` and the `@part` row holding T (Lite kept). Nullability, a unique
     * index and an initializer do not apply to a collection.
     */
    function convertToCollection(): void {
        if (shape == null || m.typeSpan == null)
            return;
        const row = collectionRow(p.cls, m.name, shape.lite ? `Lite<${shape.base}>` : shape.base, true, p.knownTypes);
        const edits: Edit[] = [row.rowEdit, { span: m.typeSpan, text: row.memberType }];
        if (m.accessorSpan != null)
            edits.push({ span: { start: m.accessorSpan.start, end: m.nameSpan.start }, text: "" });
        if (m.initializerSpan != null)
            edits.push({ span: { start: m.typeSpan.end, end: m.initializerSpan.end }, text: "" });
        const unique = decorator("uniqueIndex");
        if (unique != null)
            edits.push(p.removeDecorator(unique));
        p.apply(edits);
    }

    return (
        <fieldset className="mb-4">
            <legend className="text-h6 font-medium">{M.Field.niceToString()}: <code>{m.name}</code></legend>

            <Row label={M.Name.niceToString()}>
                <CommitInput value={m.name} onCommit={v => { if (/^[A-Za-z_$][\w$]*$/.test(v)) void p.rename(m.nameSpan.start, v); }} />
            </Row>

            {shape == null ?
                <Row label={M.Type.niceToString()}><code>{m.typeText ?? "—"}</code></Row> :
                <>
                    <Row label={M.Type.niceToString()}>
                        {/* Choosing an entity makes it Lite, as a reference to another entity usually is. */}
                        <TypeInput value={shape.base} knownTypes={p.knownTypes}
                            onCommit={t => setType({ ...shape, base: t.name, lite: t.kind === "entity" })} />
                    </Row>
                    {!shape.array &&
                        <Row label="">
                            <Check label={M.Nullable.niceToString()} checked={shape.nullable}
                                onChange={v => setType({ ...shape, nullable: v })} />
                        </Row>}
                    {isEntity &&
                        <Row label="">
                            <div>
                                <Check label={M.Lite.niceToString()} checked={shape.lite}
                                    onChange={v => setType({ ...shape, lite: v })} />
                                <div className="form-text mt-0">{M.LiteHelp.niceToString()}</div>
                            </div>
                        </Row>}
                    {!shape.array && !isCollectionRow &&
                        <Row label="">
                            <a href="#" onClick={e => { e.preventDefault(); convertToCollection(); }}>
                                <FontAwesomeIcon aria-hidden={true} icon="list" /> {M.ConvertToCollection.niceToString()}
                            </a>
                        </Row>}
                    {/* The member's own decorators, apart from what describes its type. */}
                    {!shape.array &&
                        <Row label="">
                            <Check label={M.UniqueIndex.niceToString()} checked={decorator("uniqueIndex") != null}
                                onChange={v => toggleDecorator("uniqueIndex", v)} />
                            {isPart && isEntity &&
                                <Check label={M.BackReference.niceToString()} checked={decorator("backReference") != null}
                                    onChange={v => toggleDecorator("backReference", v)} />}
                            {isPart &&
                                <Check label={M.ValueField.niceToString()} checked={decorator("valueField") != null}
                                    onChange={v => toggleDecorator("valueField", v)} />}
                        </Row>}
                    {!shape.array && (numericTypes.includes(shape.base) || dateTypes.includes(shape.base)) &&
                        <>
                            {numericTypes.includes(shape.base) &&
                                <Row label={M.Unit.niceToString()}>
                                    <CommitInput value={stringArg(decorator("unit"))} onCommit={v => setStringDecorator("unit", v)} />
                                </Row>}
                            <Row label={M.Format.niceToString()}>
                                <CommitInput value={stringArg(decorator("format"))} onCommit={v => setStringDecorator("format", v)} />
                            </Row>
                        </>}
                </>}

            <div className="mt-2 font-semibold">{M.Validators.niceToString()}</div>
            {validators.map(v =>
                <div key={v.name + v.start} className="flex items-center gap-1 mb-1">
                    <code className={classes("text-nowrap", !applies(v.name) && "text-warning")}
                        title={applies(v.name) ? undefined : M.DoesNotApplyTo0.niceToString(shape?.base ?? m.typeText ?? "")}>
                        {!applies(v.name) && <FontAwesomeIcon aria-hidden={true} icon="triangle-exclamation" className="me-1" />}
                        {v.name.replace(/Validator$/, "")}
                    </code>
                    {v.argsSpan != null &&
                        <CommitInput value={v.argsText ?? ""} onCommit={text => p.apply([{ span: v.argsSpan!, text }])} />}
                    <button type="button" className="btn btn-sm btn-link text-destructive p-0 ms-auto" title={M.Remove.niceToString()}
                        onClick={() => p.apply([p.removeDecorator(v)])}>
                        <FontAwesomeIcon aria-hidden={true} icon="xmark" />
                    </button>
                </div>)}
            {available.length > 0 &&
                <select className="form-select form-select-sm" value=""
                    onChange={e => {
                        const recipe = validatorRecipes.find(v => v.name === e.currentTarget.value);
                        if (recipe != null)
                            p.apply([addDecorator(`${recipe.name}(${recipe.args})`)]);
                    }}>
                    <option value="">{M.AddValidator.niceToString()}</option>
                    {available.map(v => <option key={v.name} value={v.name}>{v.name.replace(/Validator$/, "")}</option>)}
                </select>}
        </fieldset>
    );
}

// ---- a class ---------------------------------------------------------------------------------------------

function ClassRecipe(p: { cls: ClassInfo; knownTypes: KnownType[]; apply: (edits: Edit[]) => void }): React.JSX.Element {
    const cls = p.cls;
    const fields = cls.members.filter(m => m.kind === "property");
    const indent = fields.at(-1)?.indent ?? cls.members[0]?.indent ?? "    ";

    /** After the last field, so fields stay together above the methods; or first, in a class with none. */
    function insertMember(text: string): Edit {
        const last = fields.at(-1);
        return last != null
            ? { span: { start: last.end, end: last.end }, text: "\n\n" + indent + text }
            : { span: { start: cls.bodyStart, end: cls.bodyStart }, text: "\n" + indent + text + "\n" };
    }

    function addField(name: string, type: string): void {
        // A binary member is an `accessor` with an initializer (see FieldRecipe.setType); an entity is Lite.
        p.apply([insertMember(type === "Uint8Array"
            ? `accessor ${name}: Uint8Array = new Uint8Array(0);`
            : `${name}: ${liteIfEntity(type, p.knownTypes)};`)]);
    }

    function addCollection(name: string, element: string, preserveOrder: boolean): void {
        const row = collectionRow(cls, name, liteIfEntity(element, p.knownTypes), preserveOrder, p.knownTypes);
        p.apply([insertMember(`${name}: ${row.memberType};`), row.rowEdit]);
    }

    const hasToString = cls.members.some(m => m.name === "toString");
    const firstString = fields.find(f => f.typeShape?.base === "string" && !f.typeShape.array);

    function addToString(): void {
        const body = firstString != null ? `this.${firstString.name}` : "this.id.toString()";
        const last = cls.members.at(-1);
        const text = ["", "", `${indent}@quoted`, `${indent}override toString(): string {`, `${indent}    return ${body};`, `${indent}}`].join("\n");
        p.apply([last != null
            ? { span: { start: last.end, end: last.end }, text }
            : { span: { start: cls.bodyStart, end: cls.bodyStart }, text: text + "\n" }]);
    }

    return (
        <fieldset className="mb-4">
            <legend className="text-h6 font-medium">{M.Class.niceToString()}: <code>{cls.name}</code></legend>
            <AddMemberForm title={M.AddField.niceToString()} typeLabel={M.Type.niceToString()} initialType="string"
                knownTypes={p.knownTypes} onAdd={(name, type) => addField(name, type)} />
            <AddMemberForm title={M.AddCollection.niceToString()} typeLabel={M.ElementType.niceToString()} initialType="string"
                knownTypes={p.knownTypes} option={M.PreserveOrder.niceToString()}
                onAdd={(name, type, preserveOrder) => addCollection(name, type, preserveOrder)} />
            {!hasToString && cls.baseText === "Entity" &&
                <button type="button" className="btn btn-sm btn-outline-secondary mt-2" onClick={addToString}>
                    <FontAwesomeIcon aria-hidden={true} icon="plus" /> {M.AddToString.niceToString()}
                </button>}
        </fieldset>
    );
}

/** A name and a type, and Add. */
function AddMemberForm(p: {
    title: string;
    typeLabel: string;
    initialType: string;
    knownTypes: KnownType[];
    option?: string;
    onAdd: (name: string, type: string, option: boolean) => void;
}): React.JSX.Element {
    const [name, setName] = React.useState("");
    const [type, setType] = React.useState(p.initialType);
    const [option, setOption] = React.useState(true);
    const nameInput = React.useRef<HTMLInputElement>(null);

    function add(): void {
        if (!/^[A-Za-z_$][\w$]*$/.test(name) || type.trim() === "")
            return;
        p.onAdd(name, type.trim(), option);
        setName("");
        nameInput.current?.focus();
    }

    return (
        <div className="mb-2">
            <div className="font-semibold mb-1">{p.title}</div>
            <Row label={M.Name.niceToString()}>
                <input ref={nameInput} className="form-control form-control-sm" value={name} onChange={e => setName(e.currentTarget.value)} />
            </Row>
            <Row label={p.typeLabel}>
                <TypeInput value={type} knownTypes={p.knownTypes} onChange={setType} />
            </Row>
            <Row label="">
                {p.option != null && <Check label={p.option} checked={option} onChange={setOption} />}
                <button type="button" className="btn btn-sm btn-primary ms-auto" disabled={name === ""} onClick={add}>
                    <FontAwesomeIcon aria-hidden={true} icon="plus" /> {M.Add.niceToString()}
                </button>
            </Row>
        </div>
    );
}

// ---- operations ------------------------------------------------------------------------------------------

type OperationKind = "Save" | "Execute" | "Delete" | "Construct" | "Clone";
const operationKinds: OperationKind[] = ["Save", "Execute", "Delete", "Construct", "Clone"];

function kindOf(name: string, typeText: string | undefined): OperationKind | undefined {
    const t = typeText ?? "";
    return t.startsWith("DeleteSymbol") ? "Delete"
        : /^ConstructSymbol<[^,>]+,\s*From</.test(t) ? "Clone"
            : t.startsWith("ConstructSymbol") ? "Construct"
                : t.startsWith("ExecuteSymbol") ? (name === "Save" ? "Save" : "Execute")
                    : undefined;
}

function symbolType(kind: OperationKind, entity: string): string {
    switch (kind) {
        case "Save": case "Execute": return `ExecuteSymbol<${entity}>`;
        case "Delete": return `DeleteSymbol<${entity}>`;
        case "Construct": return `ConstructSymbol<${entity}>`;
        case "Clone": return `ConstructSymbol<${entity}, From<${entity}>>`;
    }
}

/** The statement that registers it in `start(sb)` — the default body where altea has one. */
function registration(kind: OperationKind, entity: string, symbol: string): string[] {
    switch (kind) {
        case "Save": return [`sb.include(${entity}).withSave(${symbol});`];
        case "Delete": return [`sb.include(${entity}).withDelete(${symbol});`];
        case "Construct": return [`sb.include(${entity}).withConstruct(${symbol});`];
        case "Execute": return [
            `sb.include(${entity}).withExecute(${symbol}, {`,
            `    execute: async (e, args) => {`,
            `    },`,
            `});`,
        ];
        case "Clone": return [
            `sb.include(${entity}).withConstructFrom(${entity}, ${symbol}, {`,
            `    construct: async (e, args) => {`,
            `        return ${entity}.create({});`,
            `    },`,
            `});`,
        ];
    }
}

/**
 * The type's operations: the symbols declared in `<Name>Operation` (data) and whether `<Name>Logic.start`
 * (server) registers each. Adding one does both; a declared one can be registered from here.
 */
function OperationsRecipe(p: {
    typeName: string;
    dataCtx: SyntaxContext;
    serverCtx: SyntaxContext;
    serverText: () => string;
    applyData: (edits: Edit[]) => void;
    applyServer: (edits: Edit[]) => void;
}): React.JSX.Element {
    const [kind, setKind] = React.useState<OperationKind>("Execute");
    const [name, setName] = React.useState("");

    const entity = p.typeName + "Entity";
    const container = p.typeName + "Operation";
    const declared = p.dataCtx.namespaces.find(n => n.name === container);
    const start = p.serverCtx.namespaces.find(n => n.name === p.typeName + "Logic")
        ?.members.find(m => m.kind === "function" && m.name === "start");
    const startBody = start?.bodyStart != null && start.closeLineStart != null
        ? p.serverText().slice(start.bodyStart, start.closeLineStart) : "";

    const operations = (declared?.members ?? [])
        .filter(m => m.kind === "const")
        .map(m => ({ name: m.name, kind: kindOf(m.name, m.typeText) }))
        .filter(o => o.kind != null)
        .map(o => ({ ...o, registered: new RegExp(`\\b${container}\\.${o.name}\\b`).test(startBody) }));

    function register(opKind: OperationKind, opName: string): Edit | undefined {
        if (start?.closeLineStart == null)
            return undefined;
        const indent = start.indent + "    ";
        const lines = registration(opKind, entity, `${container}.${opName}`).map(l => indent + l);
        return { span: { start: start.closeLineStart, end: start.closeLineStart }, text: "\n" + lines.join("\n") + "\n" };
    }

    function add(): void {
        if (!/^[A-Z][\w$]*$/.test(name) || operations.some(o => o.name === name))
            return;

        const declaration = `export const ${name}: ${symbolType(kind, entity)} = init();`;
        p.applyData([declared != null
            ? { span: { start: declared.closeLineStart, end: declared.closeLineStart }, text: (declared.members[0]?.indent ?? declared.indent + "    ") + declaration + "\n" }
            : { span: { start: p.dataCtx.classes.at(-1)?.end ?? 0, end: p.dataCtx.classes.at(-1)?.end ?? 0 }, text: `\n\nexport namespace ${container} {\n    ${declaration}\n}` }]);

        const edit = register(kind, name);
        if (edit != null)
            p.applyServer([edit]);
        setName("");
    }

    return (
        <fieldset className="mb-4">
            <legend className="text-h6 font-medium">{M.Operations.niceToString()}: <code>{container}</code></legend>
            {operations.map(o =>
                <div key={o.name} className="flex items-center gap-2 mb-1">
                    <code>{o.name}</code><span className="text-muted-foreground">{o.kind}</span>
                    {o.registered
                        ? <span className="ms-auto text-success"><FontAwesomeIcon aria-hidden={true} icon="check" /> {M.Registered.niceToString()}</span>
                        : start != null &&
                        <button type="button" className="btn btn-sm btn-outline-primary ms-auto py-0"
                            onClick={() => { const e = register(o.kind!, o.name); if (e != null) p.applyServer([e]); }}>
                            {M.Register.niceToString()}
                        </button>}
                </div>)}
            {start == null && <div className="text-warning mb-1">{M.TheServerModuleHasNo0.niceToString(p.typeName + "Logic.start")}</div>}

            <div className="font-semibold mt-2 mb-1">{M.AddOperation.niceToString()}</div>
            <Row label={M.Kind.niceToString()}>
                <select className="form-select form-select-sm" value={kind} onChange={e => setKind(e.currentTarget.value as OperationKind)}>
                    {operationKinds.map(k => <option key={k} value={k}>{k}</option>)}
                </select>
            </Row>
            <Row label={M.Name.niceToString()}>
                <input className="form-control form-control-sm" value={name} placeholder={kind === "Save" ? "Save" : "Bake"}
                    onChange={e => setName(e.currentTarget.value)} onKeyDown={e => { if (e.key === "Enter") add(); }} />
            </Row>
            <Row label="">
                <button type="button" className="btn btn-sm btn-primary ms-auto" disabled={name === ""} onClick={add}>
                    <FontAwesomeIcon aria-hidden={true} icon="plus" /> {M.Add.niceToString()}
                </button>
            </Row>
        </fieldset>
    );
}

// ---- small pieces ----------------------------------------------------------------------------------------

/**
 * The value types, the module's own classes, and every entity, embedded, model and enum the client knows —
 * the application's, the framework's and the dynamic ones alike (the registries the dynamic code's imports
 * resolve against). `@part` rows are left out: a row belongs to its collection.
 */
function useKnownTypes(context: SyntaxContext | null): KnownType[] {
    const schema = React.useMemo(() => {
        const result: KnownType[] = [];
        for (const ctor of getRegisteredTypes()) {
            if (isPartType(ctor))
                continue;
            const proto: unknown = ctor.prototype;
            const kind: TypeKind | undefined = proto instanceof Entity ? "entity"
                : proto instanceof EmbeddedEntity ? "embedded"
                    : proto instanceof ModelEntity ? "model" : undefined;
            if (kind != null)
                result.push({ name: ctor.name, kind });
        }
        for (const [name] of getRegisteredEnums())
            result.push({ name, kind: "enum" });
        return result.sort((a, b) => a.name.localeCompare(b.name));
    }, []);

    const own = (context?.classes ?? [])
        .filter(c => !c.decorators.some(d => d.name === "part"))
        .flatMap((c): KnownType[] => {
            const kind: TypeKind | undefined = c.baseText === "Entity" ? "entity"
                : c.baseText === "EmbeddedEntity" ? "embedded"
                    : c.baseText === "ModelEntity" ? "model" : undefined;
            return kind == null ? [] : [{ name: c.name, kind }];
        });

    const seen = new Set<string>();
    return [...valueTypes.map((name): KnownType => ({ name, kind: "value" })), ...own, ...schema]
        .filter(t => !seen.has(t.name) && seen.add(t.name) != null);
}

function typeKindOf(name: string, knownTypes: KnownType[]): TypeKind | undefined {
    return knownTypes.find(t => t.name === name)?.kind ?? (/Entity$/.test(name) ? "entity" : undefined);
}

function liteIfEntity(type: string, knownTypes: KnownType[]): string {
    return typeKindOf(type, knownTypes) === "entity" ? `Lite<${type}>` : type;
}

/**
 * A collection is a member typed as an array of a generated `@part` ROW: a back reference to the owner, an
 * optional `@rowOrder`, and the element — an embedded is an ordinary member, anything else the row's
 * `@valueField`. The row goes right after the owner class.
 */
function collectionRow(cls: ClassInfo, name: string, element: string, preserveOrder: boolean, knownTypes: KnownType[]):
    { memberType: string; rowEdit: Edit } {
    const row = `${cls.name}_${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
    const owner = cls.name.replace(/(Entity|Embedded|Mixin|Model)$/, "");
    const backReference = owner.slice(0, 1).toLowerCase() + owner.slice(1);
    const embedded = typeKindOf(element, knownTypes) === "embedded";
    const lines = [
        "", "",
        "@part",
        `export class ${row} extends Entity {`,
        "    @backReference",
        `    ${backReference}: ${cls.name};`,
        ...preserveOrder ? ["", "    @rowOrder", "    order: int;"] : [],
        "",
        ...embedded ? [] : ["    @valueField"],
        `    element: ${element};`,
        "}",
    ];
    return { memberType: `${row}[]`, rowEdit: { span: { start: cls.end, end: cls.end }, text: lines.join("\n") } };
}

const kindLabels: Record<TypeKind, () => string> = {
    value: () => M.ValueKind.niceToString(),
    entity: () => M.EntityKind.niceToString(),
    embedded: () => M.EmbeddedKind.niceToString(),
    enum: () => M.EnumKind.niceToString(),
    model: () => M.ModelKind.niceToString(),
};

/**
 * A type, with suggestions as you type: the value types first, then the schema's. `onChange` follows every
 * keystroke; `onCommit` fires once, on a pick from the list or on leaving the box.
 */
function TypeInput(p: { value: string; knownTypes: KnownType[]; onChange?: (text: string) => void; onCommit?: (type: KnownType) => void }): React.JSX.Element {
    const [text, setText] = React.useState(p.value);
    React.useEffect(() => setText(p.value), [p.value]);
    const textRef = React.useRef(text);
    textRef.current = text;
    // A click on a suggestion BLURS the input before it selects: the blur waits, and a selection cancels it.
    const blurTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    React.useEffect(() => () => clearTimeout(blurTimer.current), []);

    function commit(name: string): void {
        clearTimeout(blurTimer.current);
        const trimmed = name.trim();
        if (trimmed !== "" && trimmed !== p.value)
            p.onCommit?.(p.knownTypes.find(t => t.name === trimmed) ?? { name: trimmed, kind: typeKindOf(trimmed, p.knownTypes) ?? "value" });
    }

    function change(value: string): void {
        setText(value);
        p.onChange?.(value);
    }

    return (
        <Typeahead value={text} minLength={0} itemsDelay={0}
            inputAttrs={{ className: "form-control form-control-sm" }}
            getItems={query => {
                const q = query.toLowerCase();
                const matches = p.knownTypes.filter(t => t.name.toLowerCase().includes(q));
                const first = matches.filter(t => t.name.toLowerCase().startsWith(q));
                return Promise.resolve([...first, ...matches.filter(t => !first.includes(t))].slice(0, 30));
            }}
            renderItem={(item, highlighter: TextHighlighter) => {
                const t = item as KnownType;
                return (
                    <span className="flex gap-4">
                        <span>{highlighter.highlight(t.name)}</span>
                        <small className="text-muted-foreground ms-auto">{kindLabels[t.kind]()}</small>
                    </span>
                );
            }}
            onSelect={item => {
                const t = item as KnownType;
                change(t.name);
                commit(t.name);
                return t.name;
            }}
            onChange={change}
            onBlur={() => { blurTimer.current = setTimeout(() => commit(textRef.current), 200); }} />
    );
}

/** The text of a one-string-argument decorator: `"kg"` for `@unit("kg")`. */
function stringArg(d: DecoratorInfo | undefined): string {
    const text = d?.argsText?.trim();
    if (text == null || text === "")
        return "";
    try {
        const value = JSON.parse(text.replace(/^'(.*)'$/, "\"$1\""));
        return typeof value === "string" ? value : text;
    } catch {
        return text;
    }
}

function Row(p: { label: string; children: React.ReactNode }): React.JSX.Element {
    return (
        <div className="row g-1 items-center mb-1">
            <label className="col-4 col-form-label col-form-label-sm">{p.label}</label>
            <div className="col-8 flex gap-2 items-center flex-wrap">{p.children}</div>
        </div>
    );
}

function Check(p: { label: string; checked: boolean; onChange: (value: boolean) => void }): React.JSX.Element {
    return (
        <label className="form-check-label flex items-center gap-1">
            <input type="checkbox" className="form-check-input m-0" checked={p.checked} onChange={e => p.onChange(e.currentTarget.checked)} />
            {p.label}
        </label>
    );
}

/** An input that writes back on Enter or blur — never per keystroke, which would re-key the panel mid-word. */
function CommitInput(p: { value: string; onCommit: (value: string) => void; list?: string }): React.JSX.Element {
    const [text, setText] = React.useState(p.value);
    React.useEffect(() => setText(p.value), [p.value]);

    const commit = (): void => {
        if (text.trim() !== p.value)
            p.onCommit(text.trim());
    };

    return (
        <input className="form-control form-control-sm" value={text} list={p.list}
            onChange={e => setText(e.currentTarget.value)} onBlur={commit}
            onKeyDown={e => { if (e.key === "Enter") commit(); }} />
    );
}
