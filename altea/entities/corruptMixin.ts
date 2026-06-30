import { MixinEntity } from "./entity";
import { reflect } from "./reflection";

// A mixin whose field can't be materialised — used by tests to assert the
// mixin-in-query error path (Signum's CorruptMixin). Lives in entities/ (the entity
// model), not the test stubs.
@reflect
export class CorruptMixin extends MixinEntity {
    corrupt: boolean;
}
