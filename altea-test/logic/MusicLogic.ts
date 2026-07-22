import { SchemaBuilder } from "@altea/altea/logic/schema";
import { table } from "@altea/altea/logic/table";
import { withQuoted } from "@altea/altea/entities/decorators";
import type { IQuery } from "@altea/altea/entities/iquery";
import "@altea/altea/logic/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery / withExpressionTo / withExpressionFrom
import {
    CountryEntity,
    LabelEntity,
    ArtistEntity,
    GrammyAwardEntity,
    AmericanMusicAwardEntity,
    PersonalAwardEntity,
    BandEntity,
    AlbumEntity,
    AwardNominationEntity,
    ConfigEntity,
    NoteWithDateEntity,
    FolderEntity,
    SimplePassageEntity,
    MinimumExtensions,
} from "../entities/music";
import { includeGetDatesInRange } from "@altea/altea/logic/queryTimeSeries";

// Registers every Music table in the schema. Mirrors Signum.Test's
// MusicLogic.Start (the include(...) calls): takes the SchemaBuilder and returns
// void, leaving the final sb.complete() to the starter. The abstract AwardEntity
// is not included directly — only its concrete subclasses get tables; it is
// reached polymorphically through @implementedBy.
//
// The part entities that replace Signum's MList fields (ArtistEntity_Friends,
// BandEntity_Members, BandEntity_OtherAwards, AlbumEntity_Songs,
// AwardNominationEntity_Points, ConfigEntity_Awards, NoteWithDateEntity_Colaborators)
// are pulled in transitively via the owners' @include(() => Child) collections
// (and, for Colaborators, via NoteWithDateEntity's ColaboratorsMixin) — so they
// are intentionally NOT listed here.
export namespace MusicLogic {
    export function start(sb: SchemaBuilder): void {
        // Signum's MusicLogic.Start opts each entity into being a query (Signum's WithQuery). altea's
        // WithQuery is PARAMETERLESS — the query is `table(T)`, its shape is the entity, and columns
        // are navigated as rootless tokens ("Name", "Customer.Name", …). Default display columns are a
        // client concern; computed columns are registered expressions (withExpressionFrom/To below).
        sb.include(CountryEntity).withQuery();
        sb.include(LabelEntity).withQuery();
        sb.include(ArtistEntity).withQuery();
        sb.include(GrammyAwardEntity).withQuery();
        sb.include(AmericanMusicAwardEntity).withQuery();
        sb.include(PersonalAwardEntity).withQuery();
        sb.include(BandEntity).withQuery();

        sb.include(AlbumEntity)
            // Signum's `WithExpressionFrom((IAuthorEntity au) => au.Albums())`. altea can't key on an
            // interface (getExtensionsTokens walks the concrete prototype chain), so it registers on
            // the concrete author type ArtistEntity — `Artist.albums` → the albums authored by it.
            .withExpressionFrom(ArtistEntity, a => a.albums())
            .withQuery();

        sb.include(AwardNominationEntity).withQuery();

        sb.include(ConfigEntity);

        sb.include(NoteWithDateEntity).withQuery();
        sb.include(FolderEntity).withQuery();
        sb.include(SimplePassageEntity).withQuery();

        // Signum's MusicLogic: MinimumExtensions.IncludeFunction(sb.Schema.Assets). Registers the
        // MinimumTableValued UDF on the schema's assets so it is created by schema generation
        // (replacing the old test-only before() hook).
        MinimumExtensions.includeFunction(sb.schema.assets, sb.settings.isPostgres);

        // Signum registers GetDatesInRange framework-side (QueryTimeSeriesLogic.Start); altea has
        // no framework module start, so the time-series TVF is registered here (it drives the
        // system-versioned time-series queries — a per-date AS OF over FolderEntity).
        includeGetDatesInRange(sb.schema.assets, sb.settings.isPostgres);
    }
}

// Cross-entity expression member (Signum's [AutoExpressionField] ArtistEntity.AlbumCount):
// it counts albums whose author is this artist, which needs a query source (`table`) from
// the logic layer — so it's defined here (logic), augmenting the entity, rather than in
// the pure-entity music.ts. `withQuoted` captures the body as the translatable expression.
declare module "../entities/music" {
    interface ArtistEntity {
        albumCount(): Promise<number>;
        // Signum's IAuthorEntity.Albums(): the albums this artist authored (a query member, so the
        // body needs a `table` source from the logic layer). Registered as an extension expression.
        albums(): IQuery<AlbumEntity>;
    }
}

ArtistEntity.prototype.albumCount = withQuoted(function (this: ArtistEntity): Promise<number> {
    return table(AlbumEntity).filter(a => a.author.is(this)).count();
});

ArtistEntity.prototype.albums = withQuoted(function (this: ArtistEntity): IQuery<AlbumEntity> {
    return table(AlbumEntity).filter(a => a.author.is(this));
});
