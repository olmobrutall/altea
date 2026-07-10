import { reflect } from "@altea/altea/entities/reflection";
import { Entity, EmbeddedEntity, MixinEntity, View } from "@altea/altea/entities/entity";
import { Lite } from "@altea/altea/entities/lite";
import {
    entity, partEntity, mixin, primaryKey,
    implementedBy, implementedByAll, backReference, rowOrder, valueField,
    include, stringLengthValidator, EntityData, EntityKind,
    quoted, column, forceNullable, tableName, viewPrimaryKey,
} from "@altea/altea/entities/decorators";
import { Temporal, int, toInt } from "@altea/altea/entities/basics";
import { CorruptMixin } from "@altea/altea/entities/corruptMixin";
import { sqlMethod, returnType, resultType } from "@altea/altea/logic/query";
import { LiteralType } from "@altea/altea/entities/types";
import type { SchemaAssets } from "@altea/altea/logic/sync/schemaAssets";

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
    @include(() => NoteWithDateEntity_Colaborators)
    colaborators: NoteWithDateEntity_Colaborators[];
}

// Link rows for NoteWithDateEntity.colaborators (MList<ArtistEntity>).
@partEntity
export class NoteWithDateEntity_Colaborators extends Entity {
    @backReference
    noteWithDate: Lite<NoteWithDateEntity>;

    @valueField
    colaborator: ArtistEntity;
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

    // Computed query members (Signum's [AutoExpressionField]) — @quoted captures the body as a
    // translatable expression (no real column); methods, so the @field transformer skips them.
    // The binder inlines the @quoted body when the member is called in a query (fromQuoted reads
    // `__quoted` off the method), so `a.isMale()`, `a.fullName()`, `a.friendsCovariant()`, etc.
    // translate to SQL like any other expression.
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

    // Signum's [AutoExpressionField] ToString => Name: a translatable expression, so
    // it's expanded inline in queries and the entity carries no stored ToStr column.
    @quoted
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

    // Signum's [AutoExpressionField] ToString => Name (see ArtistEntity): expanded
    // inline, no stored ToStr column.
    @quoted
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
    member: ArtistEntity;
}

// Link rows for BandEntity.otherAwards (MList<AwardEntity>, polymorphic award).
@partEntity
export class BandEntity_OtherAwards extends Entity {
    @backReference
    band: Lite<BandEntity>;

    @implementedBy(() => [GrammyAwardEntity, AmericanMusicAwardEntity])
    @valueField
    award: Entity;
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

    // Signum's [AutoExpressionField] ToString => Name.
    @quoted
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
    @forceNullable // Signum's [ForceNullable]: non-null field, nullable column
    label: LabelEntity;
    state: AlbumState;

    // Signum's [AutoExpressionField] ToString => $"{Name} ({Author})". `author` is an
    // @implementedBy reference; its `.toString()` lowers to a CASE over each implementation's
    // display string (Artist/Band → name). Computed inline, so no stored ToStr column.
    // (`.toString()` is explicit — the quote transform captures `${this.author}` as a bare
    // reference, unlike C# where the compiler inserts the ToString call.)
    @quoted
    toString(): string {
        return `${this.name} (${this.author.toString()})`;
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

    // Signum's [AutoExpressionField] ToString => Name.
    @quoted
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

// Signum's MyTempView (JoinGroupTest's temporary-table view) — a view whose
// [TableName("#MyTempView")] names a SQL Server temp table. A view class = @reflect (Signum's
// `: IView`) + @tableName; its single FK column `artist` is a Lite<ArtistEntity> reference.
// Unlike a catalog view it has NO @viewPrimaryKey (temp-table views project columns directly and
// never dedup rows, so ViewBuilder synthesizes a representative PK from the first column). Used
// by the UnsafeInsertMyView (unsafeInsert) and LeftOuterMyView (joinGroup) tests.
@reflect
@tableName("#MyTempView")
export class MyTempView extends View {
    artist!: Lite<ArtistEntity>;
}

// Signum's UnsafeUpdateTest.MyTempView — a SEPARATE `#MyView` class (distinct from the JoinGroup
// one above), renamed here to avoid the collision. `myId` is the @viewPrimaryKey (the correlation
// key UnsafeUpdateView needs); `used` is a plain value column. Used by UnsafeUpdateMyView.
@reflect
@tableName("#MyTempView2")
export class MyTempView2 extends View {
    @viewPrimaryKey myId: int;
    used: boolean;
}

// Port of Signum's `IntValue : IView` (Entities.cs) — the row type of the MinimumTableValued
// table-valued function. A plain `@reflect` view: never built into a Table, its single field
// just describes the function's output column so the binder can project `m.minValue`.
@reflect
export class IntValue extends View {
    // Signum types this `int?`; the UDF's COALESCE makes it effectively non-null, so it is a
    // plain number here (keeps `m.minValue > 2` clean without a null check).
    minValue: number;
}

// Port of Signum's `MinimumExtensions` (Entities.cs) — the [SqlMethod]-marked UDFs used only
// inside a query. `minimumTableValued` is an inline table-valued function returning `IntValue`
// rows (Signum's `IQueryable<IntValue>`); a query-only marker whose body throws. @sqlMethod
// names the SQL function (unqualified — the binder qualifies a table-valued UDF with the dialect
// default schema, `dbo.`/`public.`) and @returnType declares the row view, so the QueryBinder
// lowers the call to a `<schema>.MinimumTableValued(...)` source. The UDF itself is created by
// MinimumExtensions.includeFunction (registered on the schema's SchemaAssets in MusicLogic).
export class MinimumExtensions {
    @sqlMethod("MinimumTableValued")
    @returnType(IntValue)
    static minimumTableValued(_a: number, _b: number): IntValue[] {
        throw new Error("MinimumExtensions.minimumTableValued is a query-only SQL function marker.");
    }

    // Signum's scalar [SqlMethod("MinimumScalar")]: a plain int-returning UDF. No @returnType (a
    // scalar, not an IView row set), so the binder lowers the call to a scalar SqlFunctionExpression
    // — schema-qualified (public./dbo.) so SQL Server accepts it (an unqualified name resolves as a
    // built-in there).
    @sqlMethod("MinimumScalar")
    @resultType(() => LiteralType.number)
    static minimumScalar(_a: int | null, _b: int | null): int | null {
        throw new Error("MinimumExtensions.minimumScalar is a query-only SQL function marker.");
    }

    // Port of Signum's MinimumExtensions.IncludeFunction (Entities.cs) — registers the
    // MinimumTableValued inline table-valued UDF and the MinimumScalar scalar UDF on the schema's
    // SchemaAssets, so schema generation creates them. Called from MusicLogic.start. The exact SQL
    // is Signum's; `isPostgres` picks the dialect (Signum reads Schema.Current.Settings.IsPostgres).
    static includeFunction(assets: SchemaAssets, isPostgres: boolean): void {
        if (isPostgres) {
            // The body is written in the exact form `pg_get_functiondef` reports back (leading
            // space before RETURNS/LANGUAGE, `$function$` dollar-quote, LANGUAGE before AS), so the
            // synchronizer's clean()-comparison round-trips to an empty script. Postgres
            // canonicalises a function definition on read regardless of the submitted formatting,
            // so this is the only form that byte-matches (Signum's SchemaAssets workflow: register
            // what the DB reports). Keep in sync if the target Postgres version changes its
            // pg_get_functiondef formatting.
            assets.includeUserDefinedFunction("MinimumTableValued", `(p1 integer, p2 integer)
 RETURNS TABLE(min_value integer)
 LANGUAGE plpgsql
AS $function$
BEGIN
RETURN QUERY
SELECT Case When p1 < p2 Then p1
       Else COALESCE(p2, p1) End as MinValue;
            END
$function$`);
            assets.includeUserDefinedFunction("MinimumScalar", `(p1 integer, p2 integer)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
BEGIN
RETURN (Case When p1 < p2 Then p1
       Else COALESCE(p2, p1) End);
END
$function$`);
        } else {
            assets.includeUserDefinedFunction("MinimumTableValued", `(@Param1 Integer, @Param2 Integer)
RETURNS Table As
RETURN (SELECT Case When @Param1 < @Param2 Then @Param1
           Else COALESCE(@Param2, @Param1) End MinValue)`);
            assets.includeUserDefinedFunction("MinimumScalar", `(@Param1 Integer, @Param2 Integer)
RETURNS Integer
AS
BEGIN
   RETURN (Case When @Param1 < @Param2 Then @Param1
       Else COALESCE(@Param2, @Param1) End);
END`);
        }
    }
}
