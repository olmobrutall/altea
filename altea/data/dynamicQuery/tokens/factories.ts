import { registerTokenFactories } from "./queryToken";
import { EntityPropertyToken } from "./entityPropertyToken";
import { EntityToStringToken } from "./entityToStringToken";
import { HasValueToken } from "./hasValueToken";
import { ObjectPropertyToken } from "./objectPropertyToken";
import { AsTypeToken } from "./asTypeToken";
import { EntityTypeToken } from "./entityTypeToken";
import type { Type, Entity } from "../../entity";
import { DateToken } from "./dateToken";
import { DatePartStartToken, type DatePartStartName } from "./datePartStartToken";
import { DurationTotalToken, type DurationTotalName } from "./durationTotalToken";
import { ModuloToken } from "./moduloToken";
import { StepToken } from "./stepToken";
import { FullTextRankToken, StringSnippetToken } from "./fullTextTokens";
import { VectorDistanceToken } from "./vectorTokens";
import { CountToken } from "./countToken";
import { CollectionElementToken, CollectionElementType } from "./collectionElementToken";
import { CollectionAnyAllToken, CollectionAnyAllType } from "./collectionAnyAllToken";
import { CollectionToArrayToken, CollectionToArrayType } from "./collectionToArrayToken";
import { AggregateToken, AggregateFunction } from "./aggregateToken";
import { QuickLinksToken } from "./manualToken";
import { OperationsContainerToken } from "./operationToken";

// Single wiring point for the base's factory hook. Importing this module (or the `tokens` barrel)
// registers every concrete token so QueryToken.subTokensBase can construct them without a static
// import cycle (base ← concrete tokens ← factories, one-directional).
registerTokenFactories({
    entityProperty: (parent, fieldInfo, route) => new EntityPropertyToken(parent, fieldInfo, route),
    idProperty: (parent) => EntityPropertyToken.idProperty(parent),
    entityToString: (parent) => new EntityToStringToken(parent),
    hasValue: (parent) => new HasValueToken(parent),
    objectProperty: (parent, memberName, resultType, displayName, isMethod, format, unit) =>
        new ObjectPropertyToken(parent, memberName, resultType, displayName, isMethod, format, unit),
    // `entityCtor` is a resolved implementation ctor (Function in the factory contract) — always a
    // concrete entity type here, so narrow it to Type<Entity> for AsTypeToken's `.niceName()`.
    asType: (parent, entityCtor) => new AsTypeToken(parent, entityCtor as Type<Entity>),
    entityType: (parent) => new EntityTypeToken(parent),
    dateToken: (parent) => new DateToken(parent),
    datePartStart: (parent, name, step) => new DatePartStartToken(parent, name as DatePartStartName, step),
    durationTotal: (parent, name) => new DurationTotalToken(parent, name as DurationTotalName),
    modulo: (parent, divisor) => new ModuloToken(parent, divisor),
    step: (parent, stepSize) => new StepToken(parent, stepSize),
    fullTextRank: (parent) => new FullTextRankToken(parent),
    stringSnippet: (parent) => new StringSnippetToken(parent),
    vectorDistance: (parent) => new VectorDistanceToken(parent),
    count: (parent) => new CountToken(parent),
    aggregate: (aggregateFunction, parent, options) => new AggregateToken(aggregateFunction as AggregateFunction, parent, options),
    collectionElement: (parent, elementType) => new CollectionElementToken(parent, elementType as CollectionElementType),
    collectionAnyAll: (parent, anyAllType) => new CollectionAnyAllToken(parent, anyAllType as CollectionAnyAllType),
    collectionToArray: (parent, toArrayType) => new CollectionToArrayToken(parent, toArrayType as CollectionToArrayType),
    operationsContainer: (parent) => new OperationsContainerToken(parent),
    quickLinksContainer: (parent) => new QuickLinksToken(parent),
});
