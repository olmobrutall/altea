import { reflect } from "@altea/altea/data/reflection";
import { entity, quoted, systemVersioned } from "@altea/altea/data/decorators";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";

@entity("String", "Master")
@systemVersioned
export class FolderEntity extends Entity {
    name: string;
    parent: Lite<FolderEntity> | null;

    // Signum's [AutoExpressionField] ToString => Name.
    @quoted
    toString(): string {
        return this.name;
    }
}
