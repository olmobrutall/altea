import { registerTokenFactories } from "./queryToken";
import { EntityPropertyToken } from "./entityPropertyToken";
import { EntityToStringToken } from "./entityToStringToken";
import { HasValueToken } from "./hasValueToken";
import { ObjectPropertyToken } from "./objectPropertyToken";
import { AsTypeToken } from "./asTypeToken";
import type { Type, Entity } from "../../entity";
import { DateToken } from "./dateToken";
import { ModuloToken } from "./moduloToken";
import { CountToken } from "./countToken";
import { CollectionElementToken, CollectionElementType } from "./collectionElementToken";
import { CollectionAnyAllToken, CollectionAnyAllType } from "./collectionAnyAllToken";
import { CollectionToArrayToken, CollectionToArrayType } from "./collectionToArrayToken";
import { AggregateToken, AggregateFunction } from "./aggregateToken";

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
    dateToken: (parent) => new DateToken(parent),
    modulo: (parent, divisor) => new ModuloToken(parent, divisor),
    count: (parent) => new CountToken(parent),
    aggregate: (aggregateFunction, parent, options) => new AggregateToken(aggregateFunction as AggregateFunction, parent, options),
    collectionElement: (parent, elementType) => new CollectionElementToken(parent, elementType as CollectionElementType),
    collectionAnyAll: (parent, anyAllType) => new CollectionAnyAllToken(parent, anyAllType as CollectionAnyAllType),
    collectionToArray: (parent, toArrayType) => new CollectionToArrayToken(parent, toArrayType as CollectionToArrayType),
});
