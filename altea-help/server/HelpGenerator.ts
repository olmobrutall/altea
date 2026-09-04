import "@altea/altea/server";
import { Schema } from "@altea/altea/server/schema";
import { OperationLogic } from "@altea/altea/server/operationLogic";
import { OperationType } from "@altea/altea/server/operation";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { Entity, EmbeddedEntity, type Type } from "@altea/altea/data/entity";
import { cleanTypeName } from "@altea/altea/data/registration";
import { PropertyRoute, PropertyRouteType } from "@altea/altea/data/propertyRoute";
import { Enum } from "@altea/altea/data/enum";
import { Implementations } from "@altea/altea/data/implementations";
import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import type { OperationSymbol } from "@altea/altea/data/operations";
import type { TypeReference } from "@altea/altea/data/reflection";
import { tryGetTypeInfo } from "@altea/altea/data/reflection";
import type { EntityKind, EntityData } from "@altea/altea/data/decorators";
import { HelpKindMessage, HelpMessage, HelpLinkPrefix } from "../data/Help";

// Port of Signum.Help's HelpGenerator.cs — the prose the help pages show BEFORE anybody writes anything:
// one sentence per type, property, operation, query and query column, assembled from reflection.
//
// It is what makes the module worth having on day one, and it is the reason a help page is never empty. It
// also seeds the `[t:Order]` link tokens (see HelpLinkPrefix), so the generated text is already
// cross-linked.
//
// altea divergences:
//  - **`Validator.TryGetPropertyValidator(pr)` becomes `FieldInfo.validators`** and the NotNull filter
//    matches on `isNotNull` (altea synthesises an IMPLICIT NotNull validator for every non-nullable field,
//    so filtering by CLASS as Signum does would miss it).
//  - **`Reflector.IsMList` / `.ElementType()` become `TypeReference.array` / `.elementType`** — altea has no
//    MList, a collection is a plain `T[]` of `@part` rows.
//  - **`Type.GetTypeCode` becomes a switch on the reflected `typeName`** (altea's capitalised value-type
//    names: `String` / `Number` / `Decimal` / `Boolean` / `PlainDate` / …). `Date` is its own type here
//    rather than Signum's "DateTime with format d", so that branch reads the type, not the format.
//  - **the query half reads QUERY TOKENS**, because altea has no `QueryDescription` /
//    `ColumnDescriptionFactory` (see CLAUDE.md): the entity column becomes the query's ROOT token, and a
//    column's "shows the property X" line comes from `token.getPropertyRoute()`.
//  - `PrimaryKey` is not a distinct CLR type in altea, so Signum's `pr.Type == typeof(PrimaryKey)` branch
//    keys off the route's `id` member instead.
export namespace HelpGenerator {

    // ---- types -----------------------------------------------------------------------------------

    /** Signum's `GetEntityHelp` — "Order is an Entity. His main function is to store information on its own…". */
    export function getEntityHelp(type: Type<Entity>): string {
        const ti = tryGetTypeInfo(type);
        const gender = type.gender();

        // Signum says "<Type> is a <BaseType>" ("Order is an Entity"). altea's base is the same class
        // hierarchy, so the base's own nice name is the right phrase.
        const baseName = baseTypeNiceName(type);

        const typeIs = HelpMessage._0IsA1_G.niceToString().forGenderAndNumber(gender)
            .formatWith(type.niceName(), baseName);

        const kind = HelpKindMessage.HisMainFunctionIsTo0.niceToString(
            entityKindMessage(ti?.entityKind, ti?.entityData, gender));

        return typeIs + ". " + kind + ".";
    }

    function baseTypeNiceName(type: Function): string {
        const base = Object.getPrototypeOf(type) as Function | null;
        if (base == null || base === Function.prototype || base.name === "")
            return Entity.name;

        // A named ABSTRACT base (CustomerEntity) has a real nice name; the FRAMEWORK bases (Entity,
        // EmbeddedEntity) are registered too but have no translated name, and `niceName()` then answers
        // the empty string — which produced "Order is a ." on the first live run. Fall back to the class
        // name, which is what Signum's `type.BaseType.NiceName()` yields for those.
        const niceName = tryGetTypeInfo(base) != null ? (base as unknown as Type<Entity>).niceName() : "";
        return niceName !== "" ? niceName : base.name;
    }

    /** Signum's `GetEntityKindMessage`. */
    function entityKindMessage(kind: EntityKind | undefined, data: EntityData | undefined, gender: string | undefined): string {
        const dataMsg = data === "Master"
            ? HelpKindMessage.AndIsMasterDataRarelyChanges.niceToString().forGenderAndNumber(gender)
            : HelpKindMessage.andIsTransactionalDataCreatedRegularly.niceToString().forGenderAndNumber(gender);

        const auto = HelpKindMessage.AutomaticallyByTheSystem.niceToString();

        switch (kind) {
            case "SystemString": return HelpKindMessage.ClassifyOtherEntities.niceToString() + auto + dataMsg;
            case "System": return HelpKindMessage.StoreInformationOnItsOwn.niceToString() + auto + dataMsg;
            case "Relational": return HelpKindMessage.RelateOtherEntities.niceToString() + dataMsg;
            case "String": return HelpKindMessage.ClassifyOtherEntities.niceToString() + dataMsg;
            case "Shared": return HelpKindMessage.StoreInformationSharedByOtherEntities.niceToString() + dataMsg;
            case "Main": return HelpKindMessage.StoreInformationOnItsOwn.niceToString() + dataMsg;
            case "Part": return HelpKindMessage.StorePartOfTheInformationOfAnotherEntity.niceToString() + dataMsg;
            case "SharedPart": return HelpKindMessage.StorePartsOfInformationSharedByDifferentEntities.niceToString() + dataMsg;
            // An enum-entity table (and any type registered with @reflect rather than @entity) has no kind.
            default: return HelpKindMessage.StoreInformationOnItsOwn.niceToString() + dataMsg;
        }
    }

    // ---- properties ------------------------------------------------------------------------------

    /** Signum's `GetPropertyHelp` — one sentence describing the property's TYPE plus its validations. */
    export function getPropertyHelp(pr: PropertyRoute): string {
        const fi = pr.fieldInfo;
        const type = pr.type;
        const niceName = fi?.niceToString() ?? pr.member;

        // Signum: `validators.CommaAnd(v => v.HelpMessage)`, skipping NotNull (the "(optional)" suffix
        // already carries nullability). altea's implicit NotNull is not a distinguishable CLASS, so the
        // filter is the `isNotNull` flag.
        const messages = (fi?.validators ?? []).filter(v => !v.isNotNull).map(v => v.helpMessage);
        let validations = messages.length === 0 ? "" : HelpMessage.Should.niceToString() + messages.joinComma(" and ");
        validations += ".";

        const orNull = type.isNullable ? HelpMessage.Optional.niceToString() : null;

        if (pr.propertyRouteType === PropertyRouteType.FieldOrProperty && pr.member === "id")
            // ALTEA: `PrimaryKey` is not a distinct type here, so the reflected `typeName` would just say
            // "PrimaryKey". The real answer is on the column: `@primaryKey("uuid")` vs the default int
            // (Signum reads `PrimaryKey.Type(pr.RootType)` for exactly the same reason).
            return HelpMessage._0IsThePrimaryKeyOf1OfType2.niceToString()
                .formatWith(niceName, rootTypeNiceName(pr), primaryKeyTypeName(fi)) + validations;

        if (type.array) {
            const element = type.elementType!;

            if (isEntityLike(element)) {
                const imp = tryImplementations(pr.add("Item")) ?? tryImplementations(pr);
                return HelpMessage._0IsACollectionOfElements1.niceToString(niceName, typeLinks(imp, element)) + validations;
            }

            if (isEmbedded(element))
                return HelpMessage._0IsACollectionOfElements1.niceToString(niceName, elementTypeNiceName(element)) + validations;

            return HelpMessage._0IsACollectionOfElements1.niceToString(niceName, valueTypeOf(element, undefined, fi?.format, fi?.unit)) + validations;
        }

        if (isEntityLike(type)) {
            const imp = tryImplementations(pr);
            const kind = type.lite ? HelpMessage.lite.niceToString() : HelpMessage.full.niceToString();
            return HelpMessage.AReference1ToA2_G.niceToString().forGenderAndNumber(genderOf(type))
                .formatWith(niceName, kind, typeLinks(imp, type)) + (orNull ?? "");
        }

        if (isEmbedded(type))
            return HelpMessage.AnEmbeddedEntityOfType0.niceToString(elementTypeNiceName(type)) + (orNull ?? "");

        const valueType = valueTypeOf(type, type.isNullable, fi?.format, fi?.unit);

        return HelpMessage._0IsA1_G.niceToString().forGenderAndNumber(undefined)
            .formatWith(niceName, valueType) + validations;
    }

    /** "integer" or "string", per `@primaryKey(…)` (Signum's `PrimaryKey.Type(rootType)`). */
    function primaryKeyTypeName(fi: { columnOptions?: { primaryKey?: string } } | undefined): string {
        const pk = fi?.columnOptions?.primaryKey;
        return pk === "uuid" || pk === "uuid7"
            ? HelpMessage.String.niceToString()
            : HelpMessage.Integer.niceToString();
    }

    function rootTypeNiceName(pr: PropertyRoute): string {
        const root = pr.rootType;
        return root == null ? "" : (root as unknown as Type<Entity>).niceName();
    }

    function genderOf(type: TypeReference): string | undefined {
        const ctor = type.getFunction();
        return ctor == null ? undefined : (ctor as unknown as Type<Entity>).gender();
    }

    function elementTypeNiceName(type: TypeReference): string {
        const ctor = type.getFunction();
        return ctor != null ? (ctor as unknown as Type<Entity>).niceName() : (type.getTypeName() ?? type.typeName);
    }

    /** An entity reference, full or lite — `TypeReference.is` resolves through @implementedBy too. */
    function isEntityLike(type: TypeReference): boolean {
        return type.lite === true || type.isByAll() || type.is(Entity);
    }

    function isEmbedded(type: TypeReference): boolean {
        return type.is(EmbeddedEntity);
    }

    function tryImplementations(pr: PropertyRoute): Implementations | undefined {
        try {
            return pr.tryGetImplementations();
        } catch {
            return undefined;
        }
    }

    /** Signum's `ValueType(type, nullable, format, unit)`. */
    function valueTypeOf(type: TypeReference, nullable: boolean | undefined, format: string | undefined, unit: string | undefined): string {
        const enumObject = type.getEnum();

        const typeName =
            enumObject != null
                ? HelpMessage.ValueLike0.niceToString(
                    Enum.values(enumObject as Record<string, string | number>)
                        .map(v => Enum.niceName(enumObject as Record<string, string | number>, v))
                        .joinComma(" or "))
                : type.typeName === "Decimal" && unit === "€" ? HelpMessage.Amount.niceToString()
                    : naturalTypeDescription(type);

        const orNull = (nullable ?? type.isNullable) ? HelpMessage.Optional.niceToString() : null;

        return [typeName, unit != null ? HelpMessage.ExpressedIn.niceToString() + unit : null, orNull]
            .filter(a => a != null).join(" ");
    }

    /**
     * Signum's `NaturalTypeDescription`, keyed on altea's reflected value-type NAMES instead of C#'s
     * TypeCode. `PlainDate` gets Signum's "date" (Signum only reached that phrase through a `format == "d"`
     * check, because C# has no date-only type).
     */
    function naturalTypeDescription(type: TypeReference): string {
        switch (type.typeName) {
            case "Boolean": return HelpMessage.BooleanValue.niceToString();
            case "String": return HelpMessage.String.niceToString();
            case "Guid": return HelpMessage.String.niceToString();
            case "PlainDate": return HelpMessage.Date.niceToString();
            case "PlainDateTime":
            case "Instant":
            case "PlainTime":
            case "Duration": return HelpMessage.DateTime.niceToString();
            case "Decimal": return HelpMessage.Value.niceToString();
            case "Number":
                // ALTEA: `subTypeName` is "int" | "long" | "decimal" | "uuid" | "uuid7" — there is no
                // float/double alias, so every reflected Number is an INTEGER here (a real number is
                // typed `Decimal`, which the case above already answers "value" for). Signum's
                // Single/Double TypeCode branch therefore has nothing to match.
                return HelpMessage.Integer.niceToString();
            default: return type.getTypeName() ?? type.typeName;
        }
    }

    // ---- operations ------------------------------------------------------------------------------

    /** Signum's `GetOperationHelp`. */
    export function getOperationHelp(type: Type<Entity>, symbol: OperationSymbol): string {
        const operation = OperationLogic.tryFindOperation(symbol);
        if (operation == null)
            return "";

        const gender = type.gender();
        const canBeModified = (operation as unknown as { canBeModified?: boolean }).canBeModified === true;
        const version = canBeModified ? HelpMessage.YourVersion.niceToString() : HelpMessage.TheDatabaseVersion.niceToString();

        switch (operation.operationType) {
            case OperationType.Execute:
                return HelpMessage.Call0Over1OfThe2.niceToString().forGenderAndNumber(gender)
                    .formatWith(symbol.niceToString(), version, type.niceName());

            case OperationType.Delete:
                return HelpMessage.RemovesThe0FromTheDatabase.niceToString(type.niceName());

            case OperationType.Constructor:
                return HelpMessage.ConstructsANew0.niceToString().forGenderAndNumber(gender).formatWith(typeLink(type));

            // ALTEA DIVERGENCE — the CONSTRUCTED type is not named. Signum reads
            // `operationInfo.ReturnType` off `Graph<F,T>` through reflection; TypeScript erases it, so all
            // altea knows is the SOURCE type. Filling Signum's "Constructs a new {0}" with the source
            // instead would be actively WRONG — the first live run produced "Constructs a new [t:Order]"
            // for altea-alert's `CreateAlertFromEntity`, which builds an Alert. So these two reuse the
            // Execute phrasing, which is true whatever they build: it names the OPERATION and the source.
            case OperationType.ConstructorFrom:
                return HelpMessage.Call0Over1OfThe2.niceToString().forGenderAndNumber(gender)
                    .formatWith(symbol.niceToString(), version, type.niceName());

            case OperationType.ConstructorFromMany:
                return HelpMessage.Call0Over1OfThe2.niceToString().forGenderAndNumber(gender)
                    .formatWith(symbol.niceToString(),
                        HelpMessage.FromMany0.niceToString().formatWith(type.nicePluralName()),
                        type.niceName());
        }

        return "";
    }

    // ---- queries ---------------------------------------------------------------------------------

    /** Signum's `GetQueryHelp(IDynamicQueryCore)` — "Query of [t:Order]". */
    export function getQueryHelp(queryName: QueryName): string {
        const root = QueryLogic.tryGetRootToken(queryName);
        const imp = root?.getImplementations();
        const rootType = root?.type;

        return HelpMessage.QueryOf0.niceToString(
            rootType == null ? "" : typeLinks(imp, rootType));
    }

    /** Signum's `GetQueryColumnHelp(ColumnDescriptionFactory)`, over a query TOKEN. */
    export function getQueryColumnHelp(token: QueryToken): string {
        const typeDesc = queryColumnType(token);
        const pr = token.getPropertyRoute();

        if (pr == null)
            return HelpMessage._0IsACalculated1.niceToString(token.niceName(), typeDesc);

        return HelpMessage._0IsA1AndShows2.niceToString(token.niceName(), typeDesc,
            pr.propertyRouteType === PropertyRouteType.Root
                ? typeLink(pr.rootType as unknown as Type<Entity>)
                : HelpMessage.TheProperty0.niceToString(propertyLink(pr)));
    }

    function queryColumnType(token: QueryToken): string {
        const type = token.type;

        if (isEntityLike(type))
            return typeLinks(token.getImplementations(), type);

        if (isEmbedded(type))
            return elementTypeNiceName(type);

        return valueTypeOf(type, type.isNullable, token.format, token.unit);
    }

    // ---- link tokens -----------------------------------------------------------------------------

    /** Signum's `Implementations.TypeLinks` — "[t:Artist] or [t:Band]", or "any Entity" for @implementedByAll. */
    function typeLinks(implementations: Implementations | undefined, type: TypeReference): string {
        if (implementations != null && implementations.isByAll)
            return HelpMessage.Any.niceToString() + " " + HelpMessage.Entities.niceToString();

        if (implementations != null)
            return implementations.types.map(t => typeLink(t as unknown as Type<Entity>)).joinComma(" or ");

        // No implementations registered: a mono-typed reference, so the reference's own class IS the target.
        const ctor = type.getFunction();
        return ctor == null ? (type.getTypeName() ?? type.typeName) : typeLink(ctor as unknown as Type<Entity>);
    }

    /** `[t:Order]` when the type is mapped, else its plain nice name (Signum's `TypeLink`). */
    export function typeLink(type: Type<Entity>): string {
        // Signum gates on `TypeLogic.TryGetCleanName` (null for an unmapped type). altea's cleanTypeName is
        // a pure name transform that never fails, so the real question — "is this type in the schema, i.e.
        // does it have a help page to link to" — is asked of the schema directly.
        if (!Schema.current.tables.has(type))
            return type.niceName();
        return `[${HelpLinkPrefix.type}:${cleanTypeName(type)}]`;
    }

    /** `[p:Order.shipAddress.city]` (Signum's `PropertyLink`, with its `[[`/`]]` escaping). */
    export function propertyLink(route: PropertyRoute): string {
        const clean = cleanTypeName(route.rootType!);
        const path = route.propertyString().replaceAll("[", "[[").replaceAll("]", "]]");
        return `[${HelpLinkPrefix.property}:${clean}.${path}]`;
    }
}
