import { reflect } from "@altea/altea/data/reflection";
import { entity, quoted } from "@altea/altea/data/decorators";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";

@entity("String", "Master")
export class LabelEntity extends Entity {
    name: string;
    country: CountryEntity;          // plain (non-lite) entity reference
    owner: Lite<LabelEntity> | null; // self-reference
    // NOT YET: SqlHierarchyId Node (hierarchy type unsupported)

    // Signum's [AutoExpressionField] ToString => Name.
    @quoted
    toString(): string {
        return this.name;
    }
}

@entity("String", "Master")
export class CountryEntity extends Entity {
    name: string;

    toString(): string {
        return this.name;
    }
}
