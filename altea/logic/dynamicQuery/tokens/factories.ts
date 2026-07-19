import { registerTokenFactories } from "./queryToken";
import { EntityPropertyToken } from "./entityPropertyToken";
import { EntityToStringToken } from "./entityToStringToken";
import { HasValueToken } from "./hasValueToken";
import { NetPropertyToken } from "./netPropertyToken";
import { AsTypeToken } from "./asTypeToken";
import { DateToken } from "./dateToken";
import { ModuloToken } from "./moduloToken";
import { CountToken } from "./countToken";
import { CollectionElementToken, CollectionElementType } from "./collectionElementToken";

// Single wiring point for the base's factory hook. Importing this module (or the `tokens` barrel)
// registers every concrete token so QueryToken.subTokensBase can construct them without a static
// import cycle (base ← concrete tokens ← factories, one-directional).
registerTokenFactories({
    entityProperty: (parent, fieldInfo, route) => new EntityPropertyToken(parent, fieldInfo, route),
    idProperty: (parent) => EntityPropertyToken.idProperty(parent),
    entityToString: (parent) => new EntityToStringToken(parent),
    hasValue: (parent) => new HasValueToken(parent),
    netProperty: (parent, memberName, resultType, displayName, isMethod, format, unit) =>
        new NetPropertyToken(parent, memberName, resultType, displayName, isMethod, format, unit),
    asType: (parent, entityCtor) => new AsTypeToken(parent, entityCtor),
    dateToken: (parent) => new DateToken(parent),
    modulo: (parent, divisor) => new ModuloToken(parent, divisor),
    count: (parent) => new CountToken(parent),
    collectionElement: (parent, elementType) => new CollectionElementToken(parent, elementType as CollectionElementType),
});
