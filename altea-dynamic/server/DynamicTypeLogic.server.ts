import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import "@altea/altea/server/fluentOperations"; // FluentInclude.withOperations
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { Administrator } from "@altea/altea/server/administrator";
import { Connector } from "@altea/altea/server/connection/connector";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { StartParameters } from "@altea/altea/data/utils/startParameters";
import { getLocation } from "@altea/altea/data/registration";
import {
    DynamicTypeEntity, DynamicTypeOperation, DynamicBaseType,
    type DynamicTypeDefinition, type DynamicProperty, type DynamicValidator,
} from "../data/DynamicType";
import { DynamicCodeCompiler, type GeneratedModule } from "./DynamicCodeCompiler.server";

// Port of Signum.Dynamic's Types/DynamicTypeLogic.cs — the CODE GENERATOR: one DynamicType row becomes two
// generated modules, an ENTITY and a LOGIC, exactly as Signum generates `X.cs` and `XLogic.cs`.
//
// The shape of the port is Signum's: two generator classes with the same names and the same methods in the
// same order, so a change upstream is easy to re-apply. What differs is what the generated code SAYS,
// because the target language and the framework's own idioms differ:
//
//  - a C# `using` list becomes an IMPORT MAP, and it needs no configuration: a registered type already
//    knows the module that declares it, because the quote-transformer stamped `__fileInfo` on it, so
//    `getLocation("OrderEntity")` yields `@altea/altea-…/data/Order` (or `eastwind/orders/Order.data` for
//    an app type). Signum's `EvalLogic.Namespaces` has no counterpart at all.
//  - a `namespace` block becomes a MODULE. Nothing is nested, so Signum's `.Indent(4)` bookkeeping goes.
//  - `[EntityKind(EntityKind.Main, EntityData.Master)]` → `@entity("Main", "Master")`, and each attribute
//    becomes its own decorator line rather than being packed into one `[…, …]` group (Signum chunks them
//    at 100 characters; a decorator per line is what altea's own code looks like and what a diff wants).
//  - a backing field + `Get`/`Set` property pair becomes ONE plain property. altea tracks changes with a
//    SNAPSHOT, not with setters, so there is nothing for a setter to notify — which also retires
//    `NotifyChanges` / `[BindParent]` (see the property generator).
//  - **an operation symbol is written `init()`**, not spelled out. Signum must write
//    `OperationSymbol.Execute<XEntity>(typeof(XOperation), "Save")` because C# cannot see the member name;
//    altea's generated code writes `export const Save: ExecuteSymbol<XEntity> = init()` and the
//    quote-transformer fills in the key `"XOperation.Save"` on the way through — so the generated source
//    reads exactly like hand-written source. This is the clearest illustration of why the transformer has
//    to be in the emit pipeline.
//  - **`MList<T>` becomes a generated `@part` ROW type plus a `T[]` property**, which is the one place the
//    generator does structurally more work than Signum's. altea has no MList: a collection of values or
//    lites is child ROWS carrying a `@valueField`, and Signum's `DynamicTypeBackMListDefinition`
//    (TableName / PreserveOrder / OrderName / BackReferenceName) describes that row table one-for-one.
//  - `ToStringExpression` becomes a `@quoted toString()`; Signum's static `Expression<Func<…>>` field plus
//    `[ExpressionField]` plus an `Evaluate(this)` body are all one decorator here.
//  - Signum's `RegisterComplexQuery` + `ColumnDisplayName` + `GetAlreadyTranslatedExpressions` /
//    `GetFormattedExpressions` are NOT ported: they exist to give a computed query column a translated
//    caption through a generated `enum CodeGenQueryXMessage`, and altea resolves a column caption from the
//    field's own `@niceName` (there is no QueryDescription to hang a ColumnDisplayName on). A query field
//    that is a plain member is emitted in `withQuery`; a computed one is emitted as a `@quoted` member,
//    which is how altea spells a registered expression, and its caption follows from that member.
//  - `IsTreeEntity` is kept and means the same thing (a definition whose custom inheritance mentions
//    TreeEntity is registered by @altea/altea-tree's own `withTree`, so this generator writes no
//    operations for it), but Signum's `TreeOperation.CreateRoot` branch is left out: the tree module owns
//    those and generated code should not re-register them.

/** Signum's `GetTableName` hook — where a generated type's table goes if the definition does not say. */
export let getTableName: (dt: DynamicTypeEntity, def: DynamicTypeDefinition) => string =
    (dt, _def) => "codegen." + dt.typeName;

export namespace DynamicTypeLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(DynamicTypeEntity)
            .withUniqueIndex(e => [e.typeName])
            .withQuery()
            .withOperations(op => {
                op.withConstruct(DynamicTypeOperation.Create, {
                    construct: () => DynamicTypeEntity.create({
                        baseType: DynamicBaseType.Entity,
                        typeDefinition: JSON.stringify(emptyDefinition(), undefined, 2),
                    }),
                });

                op.withConstructFrom(DynamicTypeEntity, DynamicTypeOperation.Clone, {
                    construct: e => {
                        // Signum leaves the NAME empty on a clone — two types cannot share one — and
                        // copies the definition verbatim.
                        const result = DynamicTypeEntity.create({ baseType: e.baseType });
                        result.setDefinition(e.getDefinition());
                        return result;
                    },
                });

                // `canBeNew`, as in Signum: the first save of a type is the point.
                op.withSave(DynamicTypeOperation.Save, { canBeNew: true });
                op.withDelete(DynamicTypeOperation.Delete);
            });
    }

    /** The definition a freshly constructed type starts from. */
    export function emptyDefinition(): DynamicTypeDefinition {
        return { entityKind: "Main", entityData: "Transactional", properties: [], queryFields: [] };
    }

    /**
     * Every DynamicType row.
     *
     * Read with `ExecutionMode.global()` and TOLERATING both a missing table and a type-cache MISMATCH,
     * because this runs while the schema is being BUILT — which makes both expected rather than faults:
     *
     *  - before the first `sync` the table does not exist (Signum's own `ExistsTable` check);
     *  - the read needs TypeLogic's type↔id caches, and building those compares the database's `type` rows
     *    against the schema's types. At this moment the schema deliberately does NOT yet contain the
     *    dynamic types — generating them is what this read is for — so every one of them looks "Extra" and
     *    would throw. `withIgnoredDatabaseMismatches` is the seam for exactly this ("the schema is BEING
     *    brought up to date, so a mismatch is expected, not a fault"), and it is what the terminal's own
     *    create / sync path uses. The real check still runs at `schema.initialize()`, after the dynamic
     *    types have been included.
     *
     * Signum needs none of this: its type cache is built in `Schema.Initialize`, and a plain
     * `Database.Query` during `Start` does not consult it. It does globally disable the entity CACHE,
     * which altea has no need to: caching a type nobody has generated yet cannot have happened.
     */
    /**
     * What a generator needs to know about one DynamicType row.
     *
     * A PROJECTION, not the entity, and that is load-bearing rather than an optimisation: an optional
     * MIXIN may add columns to `dynamic_type` (@altea/altea-dynamic's own DynamicIsolationMixin does), and
     * those columns do not exist until the `sync` that follows the app declaring the mixin. Reading the
     * whole entity therefore fails with "column dt.isolation_strategy does not exist" at the exact moment
     * the definitions are needed to BUILD the schema — and a schema built without them scripts every
     * dynamic table as a DROP. Selecting only the four columns that are always there removes that hazard
     * permanently: the core generation can never depend on a column an optional module added.
     *
     * A generator that wants a mixin's field reads it ITSELF, tolerantly — see
     * DynamicIsolationLogic.strategies.
     */
    export interface DynamicTypeInfo {
        typeName: string;
        baseType: DynamicBaseType;
        /** The stored JSON. Parsed by {@link definitionOf}, as the entity's `getDefinition` would. */
        typeDefinition: string;
    }

    /** The parsed definition of a projected row (the entity's `getDefinition`, off the projection). */
    export function definitionOf(info: DynamicTypeInfo): DynamicTypeDefinition {
        return JSON.parse(info.typeDefinition) as DynamicTypeDefinition;
    }

    export async function getTypes(): Promise<DynamicTypeInfo[]> {
        // The TABLE, not the type: `existsTable` reads `table.name`, and a type the schema does not know
        // has no table at all — which is the case on the very first boot of a fresh database.
        const t = Connector.current().schema.tryTable(DynamicTypeEntity);
        if (t == null || !await Administrator.existsTable(t))
            return [];

        const { result } = await StartParameters.withIgnoredDatabaseMismatches(async () =>
            await ExecutionMode.global(async () =>
                await table(DynamicTypeEntity)
                    .map(dt => ({
                        typeName: dt.typeName,
                        baseType: dt.baseType,
                        typeDefinition: dt.typeDefinition,
                    }))
                    .toArray()));

        return result;
    }

    /** Signum's `WriteDynamicStarter` — the lines the generated starter calls, one per type. */
    export function writeDynamicStarter(types: DynamicTypeInfo[]): string[] {
        return types.map(t => `${t.typeName}Logic.start(sb);`);
    }

    /** Signum's `GetCodeFiles`: two modules per type, plus the shared before-schema module. */
    export function getCodeFiles(types: DynamicTypeInfo[]): GeneratedModule[] {
        const result: GeneratedModule[] = [];

        for (const dt of types) {
            const def = definitionOf(dt);
            result.push({
                fileName: dt.typeName + ".ts",
                content: new DynamicTypeCodeGenerator(dt.typeName, dt.baseType, def).getFileCode(),
            });
        }

        for (const dt of types) {
            const def = definitionOf(dt);
            result.push({
                fileName: dt.typeName + "Logic.ts",
                content: new DynamicTypeLogicGenerator(dt.typeName, dt.baseType, def).getFileCode(),
            });
        }

        const beforeSchema = types.map(t => definitionOf(t).customBeforeSchema).filter(c => c != null);
        result.push({
            fileName: "CodeGenBeforeSchema.ts",
            content: new DynamicBeforeSchemaGenerator(beforeSchema.map(c => c!)).getFileCode(),
        });

        return result;
    }

    /** Signum's static `GetPropertyType` — what the client's editor previews for a property. */
    export function propertyType(property: DynamicProperty): string {
        return new DynamicTypeCodeGenerator("", DynamicBaseType.Entity, emptyDefinition())
            .getPropertyType(property);
    }
}

// ---- imports -------------------------------------------------------------------------------------------

/**
 * The import block a generated module needs, in place of Signum's `using` list.
 *
 * The point of the class is that a caller never states a specifier for a TYPE: `type(name)` looks the type
 * up in the reflection registry and reads the module off the `__fileInfo` the transformer stamped, which
 * is the same mechanism @altea/altea-map and @altea/altea-help use to group a type by its owning package.
 */
class Imports {
    private readonly map = new Map<string, Set<string>>();
    /** Names that exist ONLY as types — see `addTypeOnly`. */
    private readonly typeOnly = new Set<string>();
    /** Modules imported for their SIDE EFFECT alone — see `addSideEffect`. */
    private readonly sideEffect = new Set<string>();

    add(specifier: string, ...names: string[]): void {
        const set = this.map.get(specifier) ?? new Set<string>();
        for (const n of names)
            set.add(n);
        this.map.set(specifier, set);
    }

    /**
     * Import names that are TYPES, emitted with an inline `type` modifier.
     *
     * Not cosmetic: an interface or type alias imported as a value type-checks fine (TypeScript elides it)
     * and then throws at LOAD time under ESM, because the module really does not export a runtime `int`
     * or `ExecuteSymbol`. The emit here is ESM (see DynamicCodeCompiler), so this is the difference
     * between a generated module that loads and one that does not.
     */
    addTypeOnly(specifier: string, ...names: string[]): void {
        this.add(specifier, ...names);
        for (const n of names)
            this.typeOnly.add(n);
    }

    /**
     * Import a module for its SIDE EFFECT — `import "…";` with no names.
     *
     * altea's fluent surfaces are prototype augmentations (`withSave`, `withQuery`), so a module that
     * calls one must import the file that installs it, exactly as hand-written logic modules do.
     */
    addSideEffect(specifier: string): void {
        this.sideEffect.add(specifier);
        if (!this.map.has(specifier))
            this.map.set(specifier, new Set<string>());
    }

    /**
     * Import a registered TYPE by name and return the name to write.
     *
     * An unregistered name is written as-is and imported from nowhere, which is deliberate: it is either a
     * primitive the generator handles elsewhere, or a type the author's own custom code imports.
     */
    type(name: string): string {
        // A generic like `Lite<OrderEntity>` never reaches here — the caller composes those.
        const location = getLocation(name);
        if (location != null)
            this.add(specifierOf(location.packageName, location.fileName), name);

        return name;
    }

    toCode(): string {
        return [...this.map.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([specifier, names]) => {
                if (names.size === 0 && this.sideEffect.has(specifier))
                    return `import "${specifier}";`;

                const rendered = [...names].sort()
                    .map(n => (this.typeOnly.has(n) ? "type " : "") + n)
                    .join(", ");
                return `import { ${rendered} } from "${specifier}";`;
            })
            .join("\n");
    }
}

/** `@altea/altea-dashboard` + `data/CachedQuery.ts` → `@altea/altea-dashboard/data/CachedQuery`. */
function specifierOf(packageName: string, fileName: string): string {
    return packageName + "/" + fileName.replace(/\.tsx?$/, "");
}

// ---- the ENTITY module ---------------------------------------------------------------------------------

/** Signum's DynamicTypeCodeGenerator. */
export class DynamicTypeCodeGenerator {

    readonly imports = new Imports();
    readonly isTreeEntity: boolean;

    constructor(
        readonly typeName: string,
        readonly baseType: DynamicBaseType,
        readonly def: DynamicTypeDefinition,
    ) {
        this.isTreeEntity = def?.customInheritance?.code?.includes("TreeEntity") === true;
    }

    getFileCode(): string {
        // The BODY is generated first: writing it is what discovers the imports.
        const body = this.getEntityCode();
        const operations = this.baseType === DynamicBaseType.Entity ? this.getEntityOperation() : null;

        const parts = [
            "// GENERATED by @altea/altea-dynamic (DynamicTypeLogic). Edited here, it is overwritten on the",
            "// next compile — change the DynamicType row instead.",
            "",
            this.imports.toCode(),
            "",
            body,
        ];

        if (operations != null)
            parts.push("", operations);

        if (this.def.customTypes != null)
            parts.push("", this.def.customTypes.code);

        return parts.join("\n") + "\n";
    }

    getEntityCode(): string {
        const lines: string[] = [];

        // `reflect` lives in reflection; the decorators module carries the rest.
        this.imports.add("@altea/altea/data/reflection", "reflect");
        lines.push("@reflect");
        for (const decorator of this.getEntityDecorators())
            lines.push("@" + decorator);

        lines.push(`export class ${this.getTypeNameWithSuffix()} extends ${this.getEntityBaseClass()} {`);

        for (const prop of this.def.properties) {
            const written = this.writeProperty(prop);
            if (written !== "")
                lines.push(indent(written, 4), "");
        }

        if (this.def.customEntityMembers != null)
            lines.push(indent(this.def.customEntityMembers.code, 4), "");

        const toString = this.getToString();
        if (toString != null)
            lines.push(indent(toString, 4));

        lines.push("}");

        // Every `@part` ROW type a collection property needs (altea's stand-in for an MList table).
        const rows = this.def.properties
            .filter(p => p.isMList != null)
            .map(p => this.writeMListRow(p));

        return [...lines, ...(rows.length === 0 ? [] : ["", ...rows])].join("\n");
    }

    /**
     * Signum's GetEntityOperation.
     *
     * The symbols are `init()`, and the transformer supplies each key — see the header. Signum's two
     * `requiresSaveOperation` assertions are kept verbatim: a kind that requires a Save and does not
     * declare one (or the reverse) is a definition error, and hearing it here beats hearing it from the
     * schema builder.
     */
    getEntityOperation(): string | null {
        if (this.isTreeEntity)
            return null;

        const def = this.def;
        if (def.operationCreate == null && def.operationSave == null
            && def.operationDelete == null && def.operationClone == null)
            return null;

        const t = this.typeName;
        const lines = [`export namespace ${t}Operation {`];

        this.imports.add("@altea/altea/data/reflection", "init");

        if (def.operationCreate != null) {
            this.imports.addTypeOnly("@altea/altea/data/operations", "ConstructSymbol");
            lines.push(`    export const Create: ConstructSymbol<${t}Entity> = init();`);
        }

        const requiresSave = requiresSaveOperation(def.entityKind);
        if (def.operationSave != null && !requiresSave)
            throw new Error(`DynamicType '${t}' defines Save but has entityKind = '${def.entityKind}'`);
        if (def.operationSave == null && requiresSave)
            throw new Error(`DynamicType '${t}' does not define Save but has entityKind = '${def.entityKind}'`);

        if (def.operationSave != null) {
            this.imports.addTypeOnly("@altea/altea/data/operations", "ExecuteSymbol");
            lines.push(`    export const Save: ExecuteSymbol<${t}Entity> = init();`);
        }

        if (def.operationDelete != null) {
            this.imports.addTypeOnly("@altea/altea/data/operations", "DeleteSymbol");
            lines.push(`    export const Delete: DeleteSymbol<${t}Entity> = init();`);
        }

        if (def.operationClone != null) {
            this.imports.addTypeOnly("@altea/altea/data/operations", "ConstructSymbol", "From");
            lines.push(`    export const Clone: ConstructSymbol<${t}Entity, From<${t}Entity>> = init();`);
        }

        lines.push("}");
        return lines.join("\n");
    }

    private getEntityBaseClass(): string {
        if (this.def.customInheritance != null)
            return this.def.customInheritance.code;

        const name = DynamicBaseType[this.baseType] as keyof typeof DynamicBaseType;
        this.imports.add("@altea/altea/data/entity", name);
        return name;
    }

    /** Signum's GetToString — here one `@quoted` decorator instead of a static expression field. */
    getToString(): string | null {
        if (this.def.toStringExpression == null)
            return null;

        this.imports.add("@altea/altea/data/decorators", "quoted");
        return `@quoted\noverride toString(): string {\n    return ${this.def.toStringExpression};\n}`;
    }

    getTypeNameWithSuffix(): string {
        return this.typeName + (
            this.baseType === DynamicBaseType.MixinEntity ? "Mixin" :
                this.baseType === DynamicBaseType.EmbeddedEntity ? "Embedded" :
                    this.baseType === DynamicBaseType.ModelEntity ? "Model" : "Entity");
    }

    /** Signum's GetEntityAttributes, one decorator per line. */
    private getEntityDecorators(): string[] {
        const result: string[] = [];
        const def = this.def;

        if (this.baseType !== DynamicBaseType.Entity)
            return result;

        this.imports.add("@altea/altea/data/decorators", "entity");
        result.push(`entity(${literal(def.entityKind)}, ${literal(def.entityData)})`);

        if (def.tableName != null && def.tableName !== "") {
            this.imports.add("@altea/altea/data/decorators", "tableName");
            result.push(`tableName(${literal(def.tableName)})`);
        }

        if (def.primaryKey != null) {
            // altea's `@primaryKey` takes the TYPE only; a primary key's column name and its identity are
            // schema-wide settings (SchemaSettings), not per-type options as in Signum's [PrimaryKey].
            this.imports.add("@altea/altea/data/decorators", "primaryKey");
            result.push(`primaryKey(${literal(def.primaryKey.type ?? "int")})`);
        }

        if (def.ticks != null) {
            // Signum's [TicksColumn(bool, Name =, Type =)]; altea's takes the flag only, for the same
            // reason as the primary key.
            this.imports.add("@altea/altea/data/decorators", "ticksColumn");
            result.push(`ticksColumn(${def.ticks.hasTicks === true})`);
        }

        return result;
    }

    /**
     * Signum's WriteProperty — one plain property, where Signum writes a backing field and a Get/Set pair.
     *
     * A collection is a `T[]` of the generated row type; it needs NO initializer, because the transformer
     * seeds a reflected array with `[]` (see CLAUDE.md on not restating defaults) — Signum's
     * ` = new MList<T>()` has no counterpart.
     */
    writeProperty(property: DynamicProperty): string {
        if (property.name == null || property.name === "")
            return "";

        const type = this.getPropertyType(property);
        const decorators = this.getPropertyDecorators(property);

        return [...decorators.map(d => "@" + d), `${property.name}: ${type};`].join("\n");
    }

    /**
     * The `@part` row type behind a collection property — altea's stand-in for Signum's MList table.
     *
     * `@backReference` points at the owner and `@rowOrder` preserves the order, which is exactly what
     * Signum's MList table stores; a collection of VALUES or LITES carries the element on a `@valueField`,
     * the shape altea uses wherever Signum has an MList of a non-embedded (see CLAUDE.md).
     */
    writeMListRow(property: DynamicProperty): string {
        const mlist = property.isMList!;
        const rowType = this.rowTypeName(property);
        const element = this.elementType(property);

        this.imports.add("@altea/altea/data/reflection", "reflect");
        this.imports.add("@altea/altea/data/decorators", "entity", "backReference");
        this.imports.add("@altea/altea/data/entity", "Entity");

        const lines = ["@reflect", `@entity("Part")`];

        if (mlist.tableName != null && mlist.tableName !== "") {
            this.imports.add("@altea/altea/data/decorators", "tableName");
            lines.push(`@tableName(${literal(mlist.tableName)})`);
        }

        lines.push(`export class ${rowType} extends Entity {`);
        lines.push(`    @backReference`);
        lines.push(`    ${mlist.backReferenceName ?? camel(this.getTypeNameWithSuffix())}: ${this.getTypeNameWithSuffix()};`);
        lines.push("");

        if (mlist.preserveOrder === true) {
            this.imports.add("@altea/altea/data/decorators", "rowOrder");
            this.imports.addTypeOnly("@altea/altea/data/basics", "int");
            lines.push(`    @rowOrder ${mlist.orderName ?? "order"}: int;`);
            lines.push("");
        }

        // The ELEMENT. An embedded element is an ordinary member; anything else is the row's value column.
        if (!isEmbeddedLike(property.type) || property.isLite === true) {
            this.imports.add("@altea/altea/data/decorators", "valueField");
            lines.push(`    @valueField`);
        }
        lines.push(`    element: ${element};`);
        lines.push("}");

        return lines.join("\n");
    }

    rowTypeName(property: DynamicProperty): string {
        return `${this.getTypeNameWithSuffix()}_${cap(property.name)}`;
    }

    /** The element type of a collection, without the array. */
    elementType(property: DynamicProperty): string {
        const base = this.simplifyType(property.type);
        if (property.isLite === true) {
            this.imports.add("@altea/altea/data/lite", "Lite");
            return `Lite<${base}>`;
        }
        return base;
    }

    /** Signum's GetPropertyAttributes — the PROPERTY-level decorators (validators, unit, format). */
    private getPropertyDecorators(property: DynamicProperty): string[] {
        const result: string[] = [];

        for (const v of property.validators ?? [])
            result.push(this.getValidatorDecorator(v));

        // Signum adds a NotNull for OnlyInMemory when the author declared none. altea adds an IMPLICIT
        // NotNull to every non-nullable field, so this is only needed for the OnlyInMemory case — where
        // the TypeScript type IS nullable but the column is not.
        if (property.isNullable === "OnlyInMemory"
            && !(property.validators ?? []).some(v => v.type === "NotNull"))
            result.push(this.getValidatorDecorator({ type: "NotNull" }));

        if (property.unit != null) {
            this.imports.add("@altea/altea/data/decorators", "unit");
            result.push(`unit(${literal(property.unit)})`);
        }

        if (property.format != null) {
            this.imports.add("@altea/altea/data/decorators", "format");
            result.push(`format(${literal(property.format)})`);
        }

        // Signum's `NotifyChanges` → `[BindParent]` has NO counterpart: altea tracks changes by comparing
        // against a snapshot of the whole graph, so a child does not need a parent pointer to report one.

        if (property.customPropertyAttributes != null && property.customPropertyAttributes !== "")
            result.push(property.customPropertyAttributes);

        result.push(...this.getFieldDecorators(property));
        return result;
    }

    /**
     * Signum's GetValidatorAttribute.
     *
     * One function where Signum has a class per validator plus an `ExtraArguments()` override, because a
     * discriminated union carries its own arguments — everything but `type` IS the option bag, which is
     * also exactly the shape altea's validator decorators take.
     */
    getValidatorDecorator(v: DynamicValidator): string {
        const name = camel(v.type) + "Validator";
        this.imports.add("@altea/altea/data/validators", name);

        const { type: _ignored, ...options } = v as Record<string, unknown>;
        const entries = Object.entries(options).filter(([, value]) => value != null);

        // Signum's positional-argument validators. altea's take an options object, except the two whose
        // first arguments are genuinely positional.
        if (v.type === "NumberIs" || v.type === "CountIs") {
            const o = v as { comparisonType: unknown; number: unknown };
            return `${name}(${literal(o.comparisonType)}, ${literal(o.number)})`;
        }

        if (entries.length === 0)
            return `${name}()`;

        return `${name}({ ${entries.map(([k, value]) => `${k}: ${literal(value)}`).join(", ")} })`;
    }

    /** Signum's GetFieldAttributes — the COLUMN-level decorators. */
    private getFieldDecorators(property: DynamicProperty): string[] {
        const result: string[] = [];
        const column: string[] = [];

        if (property.isNullable === "OnlyInMemory") {
            // Signum's [ForceNotNullable]. altea spells the inverse (`@forceNullable`), so a column that is
            // NOT NULL while the member is nullable is expressed by the column option.
            column.push("nullable: false");
        }

        if (property.columnName != null && property.columnName !== "")
            column.push(`columnName: ${literal(property.columnName)}`);

        if (property.size != null)
            column.push(`size: ${literal(property.size)}`);

        if (property.scale != null)
            column.push(`scale: ${literal(property.scale)}`);

        if (property.columnType != null && property.columnType !== "") {
            // Signum decides between SqlDbType and a user-defined type name; altea carries both dialects'
            // spellings, and a generated definition names one column type, so it goes to both.
            column.push(`sqlDbType: ${literal(property.columnType)}`);
            column.push(`pgDbType: ${literal(property.columnType)}`);
        }

        if (column.length > 0) {
            this.imports.add("@altea/altea/data/decorators", "column");
            result.push(`column({ ${column.join(", ")} })`);
        }

        if (property.uniqueIndex !== "No") {
            // Signum treats Yes and YesAllowNull the same here (both emit [UniqueIndex]); altea's
            // field-level `@uniqueIndex` likewise, since "allow null" is the column's own nullability.
            this.imports.add("@altea/altea/data/decorators", "uniqueIndex");
            result.push("uniqueIndex");
        }

        if (property.customFieldAttributes != null && property.customFieldAttributes !== "")
            result.push(property.customFieldAttributes);

        return result;
    }

    /** Signum's GetPropertyType. */
    getPropertyType(property: DynamicProperty): string {
        if (property.type == null || property.type === "")
            return "";

        let result = this.simplifyType(property.type);

        if (property.isLite === true) {
            this.imports.add("@altea/altea/data/lite", "Lite");
            result = `Lite<${result}>`;
        }

        if (property.isMList != null)
            return `${this.rowTypeName(property)}[]`;

        const isNullable = property.isNullable === "Yes"
            || property.isNullable === "OnlyInMemory";

        // TypeScript spells an optional value `T | null`, where C# writes `T?`.
        return result + (isNullable ? " | null" : "");
    }

    /**
     * Signum's SimplifyType — there, dropping a namespace already in the `using` list. Here it maps a
     * declared type name onto the TypeScript one and records the import it needs.
     */
    simplifyType(type: string): string {
        switch (type) {
            case "bool": case "boolean": return "boolean";
            case "string": return "string";
            case "double": case "float": case "number": return "number";
            case "int": case "long": case "decimal":
                this.imports.addTypeOnly("@altea/altea/data/basics", type);
                return type;
            case "Guid": case "uuid":
                return "string";
            case "DateTime": case "PlainDateTime":
            case "DateOnly": case "PlainDate":
            case "TimeOnly": case "PlainTime":
            case "TimeSpan": case "Duration": {
                this.imports.add("@altea/altea/data/basics", "Temporal");
                const name = type === "DateTime" ? "PlainDateTime"
                    : type === "DateOnly" ? "PlainDate"
                        : type === "TimeOnly" ? "PlainTime"
                            : type === "TimeSpan" ? "Duration" : type;
                return `Temporal.${name}`;
            }
            case "byte[]": case "Blob": case "Uint8Array":
                return "Uint8Array";
            default:
                // An entity / embedded / enum declared somewhere in the application: the registry knows
                // where, so the import writes itself.
                return this.imports.type(type);
        }
    }
}

// ---- the LOGIC module ----------------------------------------------------------------------------------

/** Signum's DynamicTypeLogicGenerator. */
export class DynamicTypeLogicGenerator {

    readonly imports = new Imports();
    readonly isTreeEntity: boolean;

    constructor(
        readonly typeName: string,
        readonly baseType: DynamicBaseType,
        readonly def: DynamicTypeDefinition,
    ) {
        this.isTreeEntity = def?.customInheritance?.code?.includes("TreeEntity") === true;
    }

    getFileCode(): string {
        const body = this.getStartBody();

        const parts = [
            "// GENERATED by @altea/altea-dynamic (DynamicTypeLogic). Edited here, it is overwritten on the",
            "// next compile — change the DynamicType row instead.",
            "",
            this.imports.toCode(),
            "",
            `export namespace ${this.typeName}Logic {`,
            "",
            "    export function start(sb: SchemaBuilder): void {",
            "        if (sb.alreadyDefined(start))",
            "            return;",
            "",
            indent(body, 8),
            "    }",
        ];

        if (this.def.customLogicMembers != null)
            parts.push("", indent(this.def.customLogicMembers.code, 4));

        parts.push("}");
        return parts.join("\n") + "\n";
    }

    private getStartBody(): string {
        const lines: string[] = [];

        this.imports.addTypeOnly("@altea/altea/server/schema", "SchemaBuilder");

        if (this.baseType === DynamicBaseType.Entity)
            lines.push(this.getInclude());

        if (this.def.customStartCode != null)
            lines.push(this.def.customStartCode.code);

        if (this.baseType === DynamicBaseType.Entity) {
            const complex = this.registerComplexOperations();
            if (complex != null)
                lines.push("", complex);
        }

        return lines.length === 0 ? "// nothing to register" : lines.join("\n");
    }

    /** Signum's GetInclude — the fluent `sb.include(X)…` chain. */
    private getInclude(): string {
        const t = this.typeName;
        this.imports.addSideEffect("@altea/altea/server/fluentOperations");
        this.imports.addSideEffect("@altea/altea/server/dynamicQuery/fluentIncludeQuery");

        const entityModule = "./" + t;
        this.imports.add(entityModule, `${t}Entity`);

        const lines = [`sb.include(${t}Entity)`];

        if (!this.isTreeEntity) {
            // A DEFAULT body only. An operation whose body the author wrote is registered below, in
            // registerComplexOperations, exactly as Signum splits them.
            if (this.def.operationSave != null && isBlank(this.def.operationSave.execute)) {
                this.imports.add(entityModule, `${t}Operation`);
                lines.push(`    .withSave(${t}Operation.Save)`);
            }

            if (this.def.operationDelete != null && isBlank(this.def.operationDelete.delete)) {
                this.imports.add(entityModule, `${t}Operation`);
                lines.push(`    .withDelete(${t}Operation.Delete)`);
            }
        }

        const mcui = this.def.multiColumnUniqueIndex;
        if (mcui != null) {
            const fields = mcui.fields.map(f => `e.${f}`).join(", ");
            lines.push(`    .withUniqueIndex(e => [${fields}]${mcui.where != null && mcui.where !== "" ? `, e => ${mcui.where}` : ""})`);
        }

        // Signum's `WithQuery(() => e => new { … })` defines the query's COLUMNS on the server. altea's
        // server `withQuery()` takes none: a query's shape is the ENTITY (AutoDynamicQueryCore), and which
        // columns a search shows by default is a CLIENT setting (`withQuerySettings`). So `queryFields`
        // does not belong here — it is emitted by the generated CLIENT module, which is also the only tier
        // that can name a token. See DynamicTypeClient.
        lines.push(`    .withQuery()`);

        return lines.join("\n") + ";";
    }

    /**
     * Signum's RegisterComplexOperations — the operations whose bodies the author wrote.
     *
     * They go on the SAME include (`sb.include` is idempotent, so reaching it again costs nothing), which
     * is how altea declares operations at all. Signum's `Graph<X>.Construct…Register(replace: true)` has no
     * counterpart here because nothing registered them first.
     */
    private registerComplexOperations(): string | null {
        const t = this.typeName;
        const def = this.def;
        const ops: string[] = [];

        const create = def.operationCreate?.construct?.trim();
        if (create != null && create !== "")
            ops.push(`    op.withConstruct(${t}Operation.Create, {\n        construct: args => {\n${indent(create, 12)}\n        },\n    });`);

        const save = def.operationSave?.execute?.trim();
        if (save != null && save !== "") {
            const canExecute = def.operationSave!.canExecute?.trim();
            ops.push(`    op.withSave(${t}Operation.Save, {\n`
                + (canExecute == null || canExecute === "" ? "" : `        canExecute: e => {\n${indent(canExecute, 12)}\n        },\n`)
                + `        execute: (e, args) => {\n${indent(save, 12)}\n        },\n    });`);
        }

        const del = def.operationDelete?.delete?.trim();
        if (del != null && del !== "") {
            const canDelete = def.operationDelete!.canDelete?.trim();
            ops.push(`    op.withDelete(${t}Operation.Delete, {\n`
                + (canDelete == null || canDelete === "" ? "" : `        canDelete: e => {\n${indent(canDelete, 12)}\n        },\n`)
                + `        delete: (e, args) => {\n${indent(del, 12)}\n        },\n    });`);
        }

        const clone = def.operationClone?.construct?.trim();
        if (clone != null && clone !== "") {
            const canConstruct = def.operationClone!.canConstruct?.trim();
            ops.push(`    op.withConstructFrom(${t}Entity, ${t}Operation.Clone, {\n`
                + (canConstruct == null || canConstruct === "" ? "" : `        canConstruct: e => {\n${indent(canConstruct, 12)}\n        },\n`)
                + `        construct: (e, args) => {\n${indent(clone, 12)}\n        },\n    });`);
        }

        if (ops.length === 0)
            return null;

        this.imports.add("./" + t, `${t}Entity`, `${t}Operation`);
        return [`sb.include(${t}Entity).withOperations(op => {`, ...ops, "});"].join("\n");
    }
}

// ---- the before-schema module --------------------------------------------------------------------------

/** Signum's DynamicBeforeSchemaGenerator — every definition's `customBeforeSchema`, in one module. */
export class DynamicBeforeSchemaGenerator {

    constructor(readonly beforeSchema: { code: string }[]) { }

    getFileCode(): string {
        const bodies = this.beforeSchema.map(c => indent(c.code, 8)).join("\n\n");

        return [
            "// GENERATED by @altea/altea-dynamic (DynamicTypeLogic).",
            "",
            "export namespace CodeGenBeforeSchema {",
            "",
            "    export function start(): void {",
            bodies === "" ? "        // nothing to run" : bodies,
            "    }",
            "}",
            "",
        ].join("\n");
    }
}

// ---- helpers -------------------------------------------------------------------------------------------

/**
 * Signum's `EntityKindAttribute.CalculateRequiresSaveOperation`: which kinds must declare a Save.
 *
 * The list is Signum's — a Main / Shared / String / SystemString entity is saved through an operation, and
 * a Part / Relational one is saved through its owner.
 */
function requiresSaveOperation(entityKind: string | undefined): boolean {
    switch (entityKind) {
        case "Main":
        case "Shared":
        case "String":
            return true;
        default:
            return false;
    }
}

function literal(value: unknown): string {
    return JSON.stringify(value ?? null);
}

function indent(text: string, spaces: number): string {
    const pad = " ".repeat(spaces);
    return text.split("\n").map(l => l.trim() === "" ? l : pad + l).join("\n");
}

function cap(s: string): string {
    return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function camel(s: string): string {
    return s.length === 0 ? s : s[0].toLowerCase() + s.slice(1);
}

function isBlank(s: string | undefined): boolean {
    return s == null || s.trim() === "";
}

/** Whether a type name denotes something stored INSIDE its owner's row rather than referenced. */
function isEmbeddedLike(typeName: string): boolean {
    return typeName.endsWith("Embedded") || typeName.endsWith("Mixin");
}
