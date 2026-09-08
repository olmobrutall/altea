import { reflect } from "@altea/altea/data/reflection";
import {
    entity, mixin, primaryKey, implementedByAll, backReference, valueField, column, forceNullable, fullTextIndex,
} from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import { Entity, MixinEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Temporal } from "@altea/altea/data/basics";
import { CorruptMixin } from "@altea/altea/data/corruptMixin";
import { ArtistEntity } from "./artist";

@entity("Shared", "Transactional")
@mixin(() => [ColaboratorsMixin, CorruptMixin])
@primaryKey("uuid")
// Full-text index over Title + Text (Signum's MusicLogic: sb.AddFullTextIndex<NoteWithDateEntity>(a => new { a.Title, a.Text })).
@fullTextIndex<NoteWithDateEntity>(a => [a.title, a.text])
export class NoteWithDateEntity extends Entity {

    @column({ nullable: true })
    title: string;

    @stringLengthValidator({ multiLine: true })
    text: string | null;

    // Signum's `[ForceNullable] [ImplementedByAll] IEntity Target` — REQUIRED in the model, NULLABLE in
    // the database, which is what lets the UnsafeUpdate suite set it to null. Without it the
    // discriminator column is NOT NULL (it carries the field's own nullability, as Signum's does).
    @forceNullable
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
    colaborators: NoteWithDateEntity_Colaborator[];
}

// Link rows for NoteWithDateEntity.colaborators (MList<ArtistEntity>).
@entity("Part")
export class NoteWithDateEntity_Colaborator extends Entity {
    @backReference
    noteWithDate: Lite<NoteWithDateEntity>;

    @valueField
    colaborator: ArtistEntity;
}
