import { reflect } from "@altea/altea/entities/reflection";
import { Entity } from "@altea/altea/entities/entity";
import { column, serialize } from "@altea/altea/entities/decorators";

// Exercises the JSON codec's field-selection (see json.test.ts): a plain mapped field, a
// @column(false) field (absent from the DB but still serialized), and a @serialize(false)
// field (a real column, persisted server-side, but never sent on the wire).
@reflect
export class GadgetEntity extends Entity {
    name: string = "";
    @column(false) cachedLabel: string = "";
    @serialize(false) secret: string = "";
}
