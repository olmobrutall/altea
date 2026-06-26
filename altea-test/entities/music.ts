import { reflect } from "@altea/altea/entities/reflection";
import { Entity, EmbeddedEntity } from "@altea/altea/entities/entity";
import { Lite } from "@altea/altea/entities/lite";
import { implementedBy, implementedByAll, backReference, backreference, rowOrder } from "@altea/altea/entities/decorators";
import { Temporal, int } from "@altea/altea/entities/basics";
import { quoted } from "@altea/altea/logic/query";

// Port of Signum.Test's Environment/Entities.cs (the "Music" domain), adapted to
// altea and the *currently implemented* feature set. Entities, interleaved enums
// and the fields within each entity are kept in the SAME ORDER as Entities.cs so
// the two files diff side-by-side.
//
// Where Signum used MList<T>, altea has no MList: every collection is modelled as
// a child / junction entity, placed immediately after its owner and named
// `<OwnerEntity>_<Property>` (e.g. AlbumEntity_Songs for AlbumEntity.Songs). The
// child carries:
//   - @backreference on the FK field that points back to the owner;
//   - @rowOrder on an int `order` column when the MList was [PreserveOrder];
//   - the element's fields flattened in (for embedded elements);
//   - @quoted() on toString (Signum's [AutoExpressionField]).
// The owner still declares the collection with @backReference((c) => c.<fk>) so
// the relationship reads from both sides.
//
// Features still not supported are commented out with a NOT-YET note, namely:
//   - SqlHierarchyId, Vector/pgvector columns
//   - per-entity custom primary-key types (PrimaryKey(typeof(Guid/long)))
//   - Operations (ExecuteSymbol/…), AutoExpressionField/As.Expression, LiteModel
//   - mixins (CorruptMixin) — the ColaboratorsMixin MList is modelled as a
//     NoteWithDateEntity_Colaborators junction instead
// `@reflect` registers each class in the type registry so cross-references
// resolve by name.

// ---- Entities (in Entities.cs declaration order) ---------------------------

@reflect
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
    // Signum's ColaboratorsMixin.Colaborators (MList<ArtistEntity>) → junction.
    // NOT YET: Mixin(CorruptMixin) — the boolean corrupt flag.
    @backReference((c: NoteWithDateEntity_Colaborators) => c.noteWithDate)
    colaborators: NoteWithDateEntity_Colaborators[];

    toString(): string {
        return `${this.creationTime.toISOString()} -> ${this.title}`;
    }
}

// Link rows for NoteWithDateEntity.colaborators (MList<ArtistEntity>).
@reflect
export class NoteWithDateEntity_Colaborators extends Entity {
    @backreference
    noteWithDate: Lite<NoteWithDateEntity>;

    colaborator: Lite<ArtistEntity>;
}

@reflect
export class ArtistEntity extends Entity {
    name: string;
    dead: boolean;
    sex: Sex;
    status: Status | null;
    @implementedByAll
    lastAward: Entity | null;
    // Signum's MList<Lite<ArtistEntity>> Friends → self many-to-many junction.
    @backReference((f: ArtistEntity_Friends) => f.artist)
    friends: ArtistEntity_Friends[];
    // Signum's MList<AwardNominationEntity> Nominations is a *virtual* MList keyed
    // by AwardNominationEntity.author (an @implementedBy reference, so it can't be
    // a plain @backReference here). Navigate it through AwardNominationEntity.

    toString(): string {
        return this.name;
    }
}

// Self many-to-many link rows for ArtistEntity.friends (MList<Lite<ArtistEntity>>).
@reflect
export class ArtistEntity_Friends extends Entity {
    @backreference
    artist: Lite<ArtistEntity>;

    friend: Lite<ArtistEntity>;
}

export enum Sex {
    Male,
    Female,
    Undefined,
}

export enum Status {
    Single,
    Married,
}

@reflect
export class BandEntity extends Entity {
    name: string;
    // Signum's MList<ArtistEntity> Members → band/member junction.
    @backReference((m: BandEntity_Members) => m.band)
    members: BandEntity_Members[];
    @implementedBy(() => [GrammyAwardEntity, AmericanMusicAwardEntity])
    lastAward: Entity | null;
    // Signum's MList<AwardEntity> OtherAwards → band/award junction.
    @backReference((a: BandEntity_OtherAwards) => a.band)
    otherAwards: BandEntity_OtherAwards[];

    toString(): string {
        return this.name;
    }
}

// Many-to-many link rows for BandEntity.members (MList<ArtistEntity>).
@reflect
export class BandEntity_Members extends Entity {
    @backreference
    band: Lite<BandEntity>;

    member: Lite<ArtistEntity>;
}

// Link rows for BandEntity.otherAwards (MList<AwardEntity>, polymorphic award).
@reflect
export class BandEntity_OtherAwards extends Entity {
    @backreference
    band: Lite<BandEntity>;

    @implementedBy(() => [GrammyAwardEntity, AmericanMusicAwardEntity])
    award: Lite<Entity>;
}

// Abstract base — only the concrete subclasses get tables. Fields are inherited
// by the subclasses' reflection metadata.
@reflect
export abstract class AwardEntity extends Entity {
    year: int;
    category: string;
    result: AwardResult;
}

export enum AwardResult {
    Won,
    Nominated,
}

@reflect
export class GrammyAwardEntity extends AwardEntity { }

@reflect
export class AmericanMusicAwardEntity extends AwardEntity { }

@reflect
export class PersonalAwardEntity extends AwardEntity { }

@reflect
export class LabelEntity extends Entity {
    name: string;
    country: CountryEntity;          // plain (non-lite) entity reference
    owner: Lite<LabelEntity> | null; // self-reference
    // NOT YET: SqlHierarchyId Node (hierarchy type unsupported)

    toString(): string {
        return this.name;
    }
}

@reflect
export class CountryEntity extends Entity {
    name: string;

    toString(): string {
        return this.name;
    }
}

@reflect
export class AlbumEntity extends Entity {
    name: string;
    year: int;
    @implementedBy(() => [ArtistEntity, BandEntity])
    author: Entity;
    // Signum's [PreserveOrder] MList<SongEmbedded> Songs → owned child rows.
    @backReference((s: AlbumEntity_Songs) => s.album)
    songs: AlbumEntity_Songs[];
    bonusTrack: SongEmbedded | null; // single (nullable) embedded
    label: LabelEntity;
    state: AlbumState;

    toString(): string {
        return `${this.name} (${this.year})`;
    }
}

// Owned child rows for AlbumEntity.songs (the per-row equivalent of SongEmbedded).
@reflect
export class AlbumEntity_Songs extends Entity {
    @backreference
    album: Lite<AlbumEntity>;

    @rowOrder
    order: int;

    name: string;
    duration: Temporal.Duration | null;
    seconds: int | null;
    index: int;

    @quoted()
    toString(): string {
        return this.name;
    }
}

export enum AlbumState {
    New,
    Saved,
}

@reflect
export class SongEmbedded extends EmbeddedEntity {
    name: string;
    duration: Temporal.Duration | null;
    seconds: int | null;
    index: int;

    toString(): string {
        return this.name;
    }
}

@reflect
export class AwardNominationEntity extends Entity {
    @implementedBy(() => [ArtistEntity, BandEntity])
    author: Lite<Entity>;
    @implementedBy(() => [GrammyAwardEntity, PersonalAwardEntity, AmericanMusicAwardEntity])
    award: Lite<Entity>;
    year: int;
    order: int;
    // Signum's [PreserveOrder] MList<NominationPointEmbedded> Points → owned child rows.
    @backReference((p: AwardNominationEntity_Points) => p.awardNomination)
    points: AwardNominationEntity_Points[];
}

// Owned child rows for AwardNominationEntity.points. NominationPointEmbedded held
// a single `Point` field, flattened in here.
@reflect
export class AwardNominationEntity_Points extends Entity {
    @backreference
    awardNomination: Lite<AwardNominationEntity>;

    @rowOrder
    order: int;

    point: int;
}

@reflect
export class ConfigEntity extends Entity {
    embeddedConfig: EmbeddedConfigEmbedded | null;
    // Signum's EmbeddedConfig.Awards (MList<Lite<GrammyAwardEntity>>) → junction.
    // An MList can't live inside an embedded here, so it hangs off ConfigEntity.
    @backReference((a: ConfigEntity_Awards) => a.config)
    awards: ConfigEntity_Awards[];
}

@reflect
export class EmbeddedConfigEmbedded extends EmbeddedEntity {
    defaultLabel: Lite<LabelEntity> | null;
    // Signum's MList<Lite<GrammyAwardEntity>> Awards is modelled as the
    // ConfigEntity_Awards junction on ConfigEntity (see above).
}

// Link rows for ConfigEntity.awards (EmbeddedConfig.Awards MList).
@reflect
export class ConfigEntity_Awards extends Entity {
    @backreference
    config: Lite<ConfigEntity>;

    award: Lite<GrammyAwardEntity>;
}

@reflect
export class FolderEntity extends Entity {
    name: string;
    parent: Lite<FolderEntity> | null;

    toString(): string {
        return this.name;
    }
}

@reflect
export class SimplePassageEntity extends Entity {
    note: Lite<NoteWithDateEntity>;
    isTitle: boolean;
    // NOT YET: Vector? Embedding (pgvector unsupported)
    chunk: string;
    index: int;
}
