import { reflect } from "@altea/altea/data/reflection";
import { entity, mixin, primaryKey, implementedByAll, backReference, valueField, stringLengthValidator, column } from "@altea/altea/data/decorators";
import { Entity, MixinEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Temporal } from "@altea/altea/data/basics";
import { CorruptMixin } from "@altea/altea/data/corruptMixin";
import { ArtistEntity } from "./artist";

@entity("Shared", "Transactional")
@mixin(() => [ColaboratorsMixin, CorruptMixin])
@primaryKey("uuid")
export class NoteWithDateEntity extends Entity {

    @column({ nullable: true })
    title: string;

    @stringLengthValidator({ multiLine: true })
    text: string | null;

    @implementedByAll
    target: Entity;

    @implementedByAll
    @column({ nullable: true })
    otherTarget: Lite<Entity> | null;

    creationTime: Temporal.PlainDateTime;

    creationDate: Temporal.PlainDate;
    releaseDate: Temporal.PlainDate | null;

    // Hand-written (not @quoted), matching Signum's NoteWithDateEntity.ToString (a plain
    // override, not [AutoExpressionField]). Its body interpolates a date the query provider
    // can't translate, so it's materialised into a stored ToStr column at save time.
    toString(): string {
        return `${this.creationTime.toString()} -> ${this.title}`;
    }
}

@reflect
export class ColaboratorsMixin extends MixinEntity {
    colaborators: NoteWithDateEntity_Colaborators[];
}

// Link rows for NoteWithDateEntity.colaborators (MList<ArtistEntity>).
@entity("Part")
export class NoteWithDateEntity_Colaborators extends Entity {
    @backReference
    noteWithDate: Lite<NoteWithDateEntity>;

    @valueField
    colaborator: ArtistEntity;
}
