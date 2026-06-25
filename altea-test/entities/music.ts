import { reflection } from "@altea/altea/entities/reflection";
import { Entity, EmbeddedEntity } from "@altea/altea/entities/entity";
import { Lite } from "@altea/altea/entities/lite";
import { implementedBy, implementedByAll } from "@altea/altea/entities/decorators";
import { Temporal, int } from "@altea/altea/entities/basics";

// Port of Signum.Test's Environment/Entities.cs (the "Music" domain), adapted to
// altea and the *currently implemented* feature set. Features not yet supported
// are commented out with a NOT-YET note, namely:
//   - MList<T> of values / embeddeds / Lite<T> and many-to-many MLists
//     (only `ChildEntity[]` back-reference arrays exist; m2m needs a junction)
//   - SqlHierarchyId, Vector/pgvector columns
//   - per-entity custom primary-key types (PrimaryKey(typeof(Guid/long)))
//   - Operations (ExecuteSymbol/…), AutoExpressionField/As.Expression, LiteModel
// `@reflection` registers each class in the type registry so cross-references
// resolve by name.

// ---- Enums -----------------------------------------------------------------

export enum Sex {
    Male,
    Female,
    Undefined,
}

export enum Status {
    Single,
    Married,
}

export enum AwardResult {
    Won,
    Nominated,
}

export enum AlbumState {
    New,
    Saved,
}

// ---- Entities --------------------------------------------------------------

@reflection
export class CountryEntity extends Entity {
    name: string;

    toString(): string {
        return this.name;
    }
}

@reflection
export class LabelEntity extends Entity {
    name: string;
    country: CountryEntity;          // plain (non-lite) entity reference
    owner: Lite<LabelEntity> | null; // self-reference
    // NOT YET: SqlHierarchyId Node (hierarchy type unsupported)

    toString(): string {
        return this.name;
    }
}

@reflection
export class ArtistEntity extends Entity {
    name: string;
    dead: boolean;
    sex: Sex;
    status: Status | null;
    @implementedByAll
    lastAward: Entity | null;
    // NOT YET: MList<Lite<ArtistEntity>> Friends, MList<AwardNominationEntity> Nominations

    toString(): string {
        return this.name;
    }
}

// Abstract base — only the concrete subclasses get tables. Fields are inherited
// by the subclasses' reflection metadata.
@reflection
export abstract class AwardEntity extends Entity {
    year: int;
    category: string;
    result: AwardResult;
}

@reflection
export class GrammyAwardEntity extends AwardEntity { }

@reflection
export class AmericanMusicAwardEntity extends AwardEntity { }

@reflection
export class PersonalAwardEntity extends AwardEntity { }

@reflection
export class BandEntity extends Entity {
    name: string;
    @implementedBy(() => [GrammyAwardEntity, AmericanMusicAwardEntity])
    lastAward: Entity | null;
    // NOT YET: MList<ArtistEntity> Members (m2m), MList<AwardEntity> OtherAwards

    toString(): string {
        return this.name;
    }
}

@reflection
export class SongEmbedded extends EmbeddedEntity {
    name: string;
    duration: Temporal.Duration | null;
    seconds: int | null;
    index: int;

    toString(): string {
        return this.name;
    }
}

@reflection
export class AlbumEntity extends Entity {
    name: string;
    year: int;
    @implementedBy(() => [ArtistEntity, BandEntity])
    author: Entity;
    bonusTrack: SongEmbedded | null; // single (nullable) embedded
    label: LabelEntity;
    state: AlbumState;
    // NOT YET: MList<SongEmbedded> Songs (embedded MList)

    toString(): string {
        return `${this.name} (${this.year})`;
    }
}

@reflection
export class AwardNominationEntity extends Entity {
    @implementedBy(() => [ArtistEntity, BandEntity])
    author: Lite<Entity>;
    @implementedBy(() => [GrammyAwardEntity, PersonalAwardEntity, AmericanMusicAwardEntity])
    award: Lite<Entity>;
    year: int;
    order: int;
    // NOT YET: MList<NominationPointEmbedded> Points (embedded MList)
}

@reflection
export class EmbeddedConfigEmbedded extends EmbeddedEntity {
    defaultLabel: Lite<LabelEntity> | null;
    // NOT YET: MList<Lite<GrammyAwardEntity>> Awards (Lite MList)
}

@reflection
export class ConfigEntity extends Entity {
    embeddedConfig: EmbeddedConfigEmbedded | null;
}

@reflection
export class NoteWithDateEntity extends Entity {
    title: string | null;
    text: string | null;
    @implementedByAll
    target: Entity;
    @implementedByAll
    otherTarget: Lite<Entity> | null;
    creationTime: Date;
    creationDate: Temporal.PlainDate;
    releaseDate: Temporal.PlainDate | null;
    // NOT YET: Mixin(CorruptMixin), Mixin(ColaboratorsMixin) — the latter is an MList

    toString(): string {
        return `${this.creationTime.toISOString()} -> ${this.title}`;
    }
}

@reflection
export class FolderEntity extends Entity {
    name: string;
    parent: Lite<FolderEntity> | null;

    toString(): string {
        return this.name;
    }
}

@reflection
export class SimplePassageEntity extends Entity {
    note: Lite<NoteWithDateEntity>;
    isTitle: boolean;
    chunk: string;
    index: int;
    // NOT YET: Vector? Embedding (pgvector unsupported)
}
