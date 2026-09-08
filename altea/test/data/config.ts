import { reflect } from "@altea/altea/data/reflection";
import { entity, part, backReference, valueField } from "@altea/altea/data/decorators";
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { LabelEntity } from "./label";
import { GrammyAwardEntity } from "./award";

@entity("Main", "Master")
export class ConfigEntity extends Entity {
    embeddedConfig: EmbeddedConfigEmbedded | null;
}

@reflect
export class EmbeddedConfigEmbedded extends EmbeddedEntity {
    defaultLabel: Lite<LabelEntity> | null;
    // Signum's MList<Lite<GrammyAwardEntity>> Awards — a collection declared INSIDE an embedded.
    // The embedded is flattened onto ConfigEntity's row, so these rows belong to the CONFIG:
    // ConfigEntity_Award's @backReference names ConfigEntity, not this embedded (an embedded has
    // no id to point at). In legacy mode the table is named from the whole route, as Signum's
    // NameSequence does: `config_embedded_config_awards`.
    awards: ConfigEntity_Award[];
}

// Link rows for EmbeddedConfig.Awards (MList<Lite<GrammyAwardEntity>>).
@part
export class ConfigEntity_Award extends Entity {
    @backReference
    config: Lite<ConfigEntity>;

    @valueField
    award: Lite<GrammyAwardEntity>;
}
