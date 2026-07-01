import { reflect } from "@altea/altea/entities/reflection";
import { Entity, EmbeddedEntity, MixinEntity } from "@altea/altea/entities/entity";
import { Lite } from "@altea/altea/entities/lite";
import {
    entity, partEntity, mixin, primaryKey,
    implementedBy, implementedByAll, backReference, rowOrder, valueField,
    include, stringLengthValidator, EntityData, EntityKind,
    quoted, column,
} from "@altea/altea/entities/decorators";
import { Temporal, int, toInt } from "@altea/altea/entities/basics";

// Port of Signum.Test's Environment/Entities.cs (the "Music" domain), adapted to
// altea and the *currently implemented* feature set. Entities, interleaved enums
// and the fields within each entity are kept in the SAME ORDER as Entities.cs so
// the two files diff side-by-side.
//
// Where Signum used MList<T>, altea has no MList: each collection becomes a
// "part" entity, placed immediately after its owner and named
// `<OwnerEntity>_<Property>` (e.g. AlbumEntity_Songs for AlbumEntity.Songs):
//   - the owner declares the collection with @include(() => Child);
//   - the child is a @partEntity that marks its owner FK with a bare
//     @backReference, the element value with @valueField, and (for
//     [PreserveOrder] MLists) the row order with @rowOrder on an int `order`;
//   - embedded MList elements are flattened into the child's columns.
// Part entities are pulled into the schema transitively via @include, so they
// are NOT listed in MusicLogic's sb.include calls.
//
// Features still not supported are commented out with a NOT-YET note, namely:
//   - SqlHierarchyId, Vector/pgvector columns
//   - Operations (ExecuteSymbol/…), AutoExpressionField/As.Expression, LiteModel
//   - mixins beyond the ColaboratorsMixin pattern (CorruptMixin)
// `@reflect` / `@entity` / `@partEntity` register each class in the type registry
// (and trigger @field injection) so cross-references resolve by name.

@entity(EntityKind.Shared, EntityData.Transactional)
@mixin(() => [ColaboratorsMixin])
//@mixin(() => [CorruptMixin])
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

    @quoted
    toString(): string {
        return `${this.creationTime.toString()} -> ${this.title}`;
    }
}

@reflect
export class ColaboratorsMixin extends MixinEntity {
    @include(() => NoteWithDateEntity_Colaborators)
    colaborators: NoteWithDateEntity_Colaborators[];
}

// Link rows for NoteWithDateEntity.colaborators (MList<ArtistEntity>).
@partEntity
export class NoteWithDateEntity_Colaborators extends Entity {
    @backReference
    noteWithDate: Lite<NoteWithDateEntity>;

    @valueField
    colaborator: Lite<ArtistEntity>;
}

// Signum's IAuthorEntity: the shared interface behind AlbumEntity.Author /
// AwardNominationEntity.Author, implemented by ArtistEntity and BandEntity. altea has
// no runtime interface type — this is a compile-time contract so a polymorphic
// `author` reference can navigate the members both implementations share. It is the
// static type `combineUnion()` / `combineCase()` return (they are `(): this`), which
// is what makes `a.author.combineUnion().name` / `.lastAward` / `.fullName()` typecheck.
export interface IAuthorEntity extends Entity {
    name: string;
    lastAward: Entity | null;
    fullName(): string;
    lonely(): boolean;
}

@reflect
export class ArtistEntity extends Entity implements IAuthorEntity {
    name: string;
    dead: boolean;
    sex: Sex;
    status: Status | null;
    @implementedByAll
    lastAward: Entity | null;
    // Signum's MList<Lite<ArtistEntity>> Friends → self many-to-many part entity.
    @include(() => ArtistEntity_Friends)
    friends: ArtistEntity_Friends[];
    // Signum's MList<AwardNominationEntity> Nominations is a *virtual* MList keyed
    // by AwardNominationEntity.author (an @implementedBy reference, so it can't be
    // a plain part entity here). Navigate it through AwardNominationEntity.

    // Computed query members (Signum's [AutoExpressionField]) — @quoted captures the
    // body as a translatable expression (no real column); methods, so the @field
    // transformer skips them. The binder doesn't expand @quoted entity members yet, so
    // queries using them run red.
    @quoted
    isMale(): boolean { return this.sex == Sex.Male; }
    @quoted
    fullName(): string { return this.name; }
    // albumCount (a cross-entity subquery: count albums where author == this) needs a
    // query source from the logic layer, so it's defined+implemented in MusicLogic, which
    // augments this interface (entities/ must not reference logic/).
    @quoted
    lonely(): boolean { return this.friends.length == 0; }
    @quoted
    friendsCovariant(): ArtistEntity[] { return this.friends.map(f => f.friend.entity); }

    toString(): string {
        return this.name;
    }
}

// Self many-to-many link rows for ArtistEntity.friends (MList<Lite<ArtistEntity>>).
@partEntity
export class ArtistEntity_Friends extends Entity {
    @backReference
    artist: Lite<ArtistEntity>;

    @valueField
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
export class BandEntity extends Entity implements IAuthorEntity {
    name: string;
    // Signum's MList<ArtistEntity> Members → band/member part entity.
    @include(() => BandEntity_Members)
    members: BandEntity_Members[];
    @implementedBy(() => [GrammyAwardEntity, AmericanMusicAwardEntity])
    lastAward: Entity | null;
    // Signum's MList<AwardEntity> OtherAwards → band/award part entity.
    @include(() => BandEntity_OtherAwards)
    otherAwards: BandEntity_OtherAwards[];

    // Computed query members (Signum's [AutoExpressionField]) — see ArtistEntity.
    @quoted
    fullName(): string { return this.name; }
    @quoted
    lonely(): boolean { return this.members.length == 0; }

    toString(): string {
        return this.name;
    }
}

// Many-to-many link rows for BandEntity.members (MList<ArtistEntity>).
@partEntity
export class BandEntity_Members extends Entity {
    @backReference
    band: Lite<BandEntity>;

    @valueField
    member: Lite<ArtistEntity>;
}

// Link rows for BandEntity.otherAwards (MList<AwardEntity>, polymorphic award).
@partEntity
export class BandEntity_OtherAwards extends Entity {
    @backReference
    band: Lite<BandEntity>;

    @implementedBy(() => [GrammyAwardEntity, AmericanMusicAwardEntity])
    @valueField
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
    author: IAuthorEntity;
    // Signum's [PreserveOrder] MList<SongEmbedded> Songs → owned part rows.
    @include(() => AlbumEntity_Songs)
    songs: AlbumEntity_Songs[];
    bonusTrack: SongEmbedded | null; // single (nullable) embedded
    label: LabelEntity;
    state: AlbumState;

    toString(): string {
        return `${this.name} (${this.year})`;
    }
}

// Owned child rows for AlbumEntity.songs (the per-row equivalent of SongEmbedded,
// whose embedded fields are flattened in here).
@partEntity
export class AlbumEntity_Songs extends Entity {
    @backReference
    album: Lite<AlbumEntity>;

    @rowOrder
    order: int;

    name: string;
    duration: Temporal.Duration | null;
    seconds: int | null;
    index: int = toInt(0); // C# value-type default (0); the loader relies on it

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
    index: int = toInt(0); // C# value-type default (0); the loader relies on it

    toString(): string {
        return this.name;
    }
}

@reflect
export class AwardNominationEntity extends Entity {
    @implementedBy(() => [ArtistEntity, BandEntity])
    author: Lite<IAuthorEntity>;
    @implementedBy(() => [GrammyAwardEntity, PersonalAwardEntity, AmericanMusicAwardEntity])
    award: Lite<Entity>;
    year: int = toInt(0);   // C# value-type default; the loader leaves these unset
    order: int = toInt(0);
    // Signum's [PreserveOrder] MList<NominationPointEmbedded> Points → owned part rows.
    @include(() => AwardNominationEntity_Points)
    points: AwardNominationEntity_Points[];
}

// Owned child rows for AwardNominationEntity.points. NominationPointEmbedded held
// a single `Point` field, flattened in here.
@partEntity
export class AwardNominationEntity_Points extends Entity {
    @backReference
    awardNomination: Lite<AwardNominationEntity>;

    @rowOrder
    order: int;

    point: int;
}

@reflect
export class ConfigEntity extends Entity {
    embeddedConfig: EmbeddedConfigEmbedded | null;
    // Signum's EmbeddedConfig.Awards (MList<Lite<GrammyAwardEntity>>) → part entity.
    // An MList can't live inside an embedded here, so it hangs off ConfigEntity.
    @include(() => ConfigEntity_Awards)
    awards: ConfigEntity_Awards[];
}

@reflect
export class EmbeddedConfigEmbedded extends EmbeddedEntity {
    defaultLabel: Lite<LabelEntity> | null;
    // Signum's MList<Lite<GrammyAwardEntity>> Awards is modelled as the
    // ConfigEntity_Awards part entity on ConfigEntity (see above).
}

// Link rows for ConfigEntity.awards (EmbeddedConfig.Awards MList).
@partEntity
export class ConfigEntity_Awards extends Entity {
    @backReference
    config: Lite<ConfigEntity>;

    @valueField
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
    index: int = toInt(0); // C# value-type default (0); the loader relies on it
}
