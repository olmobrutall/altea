import { Temporal, toInt } from "@altea/altea/entities/basics";
import {
    CountryEntity,
    LabelEntity,
    ArtistEntity,
    BandEntity,
    GrammyAwardEntity,
    AmericanMusicAwardEntity,
    SongEmbedded,
    AlbumEntity,
    NoteWithDateEntity,
    FolderEntity,
    Sex,
    Status,
    AwardResult,
    AlbumState,
} from "../entities/music";

// Mirrors Signum.Test's MusicLoader: builds a sample object graph. Since the
// save/ORM layer isn't implemented yet, this only *initializes the classes*
// in memory (via the new Entity.create factory) — persistence comes later.
// Demonstrates value fields, enums, embeddeds, plain references, polymorphic
// (@implementedBy) references and fat Lites.
export function loadSampleData() {
    const usa = CountryEntity.create({ name: "USA" });
    const uk = CountryEntity.create({ name: "UK" });

    const epic = LabelEntity.create({ name: "Epic", country: usa, owner: null });
    const sony = LabelEntity.create({ name: "Sony Music", country: usa, owner: epic.toLite(/* fat */ true) });

    const michael = ArtistEntity.create({
        name: "Michael Jackson",
        dead: true,
        sex: Sex.Male,
        status: Status.Single,
        lastAward: null,
    });

    const queen = BandEntity.create({ name: "Queen", lastAward: null });

    const grammy = GrammyAwardEntity.create({
        year: toInt(1984),
        category: "Album of the Year",
        result: AwardResult.Won,
    });
    const ama = AmericanMusicAwardEntity.create({
        year: toInt(1984),
        category: "Favorite Pop/Rock Album",
        result: AwardResult.Won,
    });

    const thriller = AlbumEntity.create({
        name: "Thriller",
        year: toInt(1982),
        author: michael,          // @implementedBy → ArtistEntity
        label: epic,
        state: AlbumState.Saved,
        bonusTrack: SongEmbedded.create({
            name: "Billie Jean",
            duration: Temporal.Duration.from({ minutes: 4, seconds: 54 }),
            seconds: toInt(294),
            index: toInt(1),
        }),
    });

    const aNightAtTheOpera = AlbumEntity.create({
        name: "A Night at the Opera",
        year: toInt(1975),
        author: queen,            // @implementedBy → BandEntity
        label: sony,
        state: AlbumState.Saved,
        bonusTrack: null,
    });

    const note = NoteWithDateEntity.create({
        title: "Reminder",
        text: "Remaster the catalogue",
        target: thriller,         // @implementedByAll → any entity
        otherTarget: null,
        creationTime: new Date("1982-11-30T00:00:00Z"),
        creationDate: Temporal.PlainDate.from("1982-11-30"),
        releaseDate: null,
    });

    const root = FolderEntity.create({ name: "Music", parent: null });
    const pop = FolderEntity.create({ name: "Pop", parent: root.toLite(true) });

    return {
        countries: [usa, uk],
        labels: [epic, sony],
        artists: [michael],
        bands: [queen],
        awards: [grammy, ama],
        albums: [thriller, aNightAtTheOpera],
        notes: [note],
        folders: [root, pop],
    };
}
