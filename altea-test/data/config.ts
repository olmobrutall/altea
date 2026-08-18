import { reflect } from "@altea/altea/data/reflection";
import { entity, backReference, valueField } from "@altea/altea/data/decorators";
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { LabelEntity } from "./label";
import { GrammyAwardEntity } from "./award";

@entity("Main", "Master")
export class ConfigEntity extends Entity {
    embeddedConfig: EmbeddedConfigEmbedded | null;
    // Signum's EmbeddedConfig.Awards (MList<Lite<GrammyAwardEntity>>) → part entity.
    // An MList can't live inside an embedded here, so it hangs off ConfigEntity.
    awards: ConfigEntity_Award[];
}

@reflect
export class EmbeddedConfigEmbedded extends EmbeddedEntity {
    defaultLabel: Lite<LabelEntity> | null;
    // Signum's MList<Lite<GrammyAwardEntity>> Awards is modelled as the
    // ConfigEntity_Award part entity on ConfigEntity (see above).
}

// Link rows for ConfigEntity.awards (EmbeddedConfig.Awards MList).
@entity("Part")
export class ConfigEntity_Award extends Entity {
    @backReference
    config: Lite<ConfigEntity>;

    @valueField
    award: Lite<GrammyAwardEntity>;
}
