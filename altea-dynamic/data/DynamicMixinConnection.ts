import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, stringLengthValidator, quoted, implementedBy } from "@altea/altea/data/decorators";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";

// Port of Signum.Dynamic's Mixins/DynamicMixinConnection.cs — "attach this mixin to this type", chosen from
// the running application.
//
// Generated code, not an eval: a mixin's fields have to be part of the SCHEMA, so the connection is written
// into a generated `CodeGenMixinLogic` module that calls `sb.mixin(...)` before the schema is built — which
// is why a new connection needs a restart and then a `sync`, and why Signum's message
// `TheEntityShouldBeSynchronizedToApplyMixins` is ported (data/DynamicType).
//
// The mixin itself is usually a DynamicType with `baseType = MixinEntity`; it can equally be a hand-written
// one, since the connection names it by clean type name.
@reflect
@entity("Main", "Master")
export class DynamicMixinConnectionEntity extends Entity {

    @implementedBy(() => [TypeEntity])
    entityType: Lite<TypeEntity>;

    @stringLengthValidator({ max: 100 })
    mixinName: string;

    @quoted
    override toString(): string {
        return this.entityType.toString() + " - " + this.mixinName;
    }
}

export namespace DynamicMixinConnectionOperation {
    export const Save: ExecuteSymbol<DynamicMixinConnectionEntity> = init();
    export const Delete: DeleteSymbol<DynamicMixinConnectionEntity> = init();
}
