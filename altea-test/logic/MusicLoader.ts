import { Temporal, toInt } from "@altea/altea/entities/basics";
import "@altea/altea/logic/save"; // installs Entity.prototype.save()
import {
    CountryEntity,
    LabelEntity,
    ArtistEntity,
    ArtistEntity_Friends,
    BandEntity,
    BandEntity_Members,
    BandEntity_OtherAwards,
    GrammyAwardEntity,
    AmericanMusicAwardEntity,
    PersonalAwardEntity,
    AlbumEntity,
    AlbumEntity_Songs,
    SongEmbedded,
    AwardNominationEntity,
    AwardNominationEntity_Points,
    ConfigEntity,
    ConfigEntity_Awards,
    EmbeddedConfigEmbedded,
    NoteWithDateEntity,
    NoteWithDateEntity_Colaborators,
    FolderEntity,
    Sex,
    Status,
    AwardResult,
    AlbumState,
} from "../entities/music";

// Port of Signum.Test's MusicLoader: builds the sample object graph and persists
// it. Now that Entity.save() is implemented, every row is written with .save()
// (no parameters — it resolves the database from the ambient connector). Parents
// are saved before they are referenced so their ids exist for the .toLite() FKs.
// Where Signum used MList<T>, the collection rows are their own entities saved
// individually (ArtistEntity_Friends, BandEntity_Members, BandEntity_OtherAwards,
// AlbumEntity_Songs, AwardNominationEntity_Points, ConfigEntity_Awards,
// NoteWithDateEntity_Colaborators).
export namespace MusicLoader {
    export async function load(): Promise<void> {
        // Countries
        const usa = CountryEntity.create({ name: "USA" });
        await usa.save();
        const japan = CountryEntity.create({ name: "Japan" });
        await japan.save();

        // Awards
        const ama = AmericanMusicAwardEntity.create({ year: toInt(1991), category: "Indie Rock", result: AwardResult.Nominated });
        await ama.save();
        const grammy = GrammyAwardEntity.create({ year: toInt(2001), category: "Foreign Band", result: AwardResult.Won });
        await grammy.save();

        // Band: Smashing Pumpkins + members (Signum's MList<ArtistEntity>)
        const smashingPumpkins = BandEntity.create({ name: "Smashing Pumpkins", lastAward: ama });
        await smashingPumpkins.save();

        const memberNames = ["Billy Corgan", "James Iha", "D'arcy Wretzky", "Jimmy Chamberlin"];
        const members: ArtistEntity[] = [];
        for (const name of memberNames) {
            const female = name.includes("Wretzky");
            const artist = ArtistEntity.create({
                name,
                dead: false,
                sex: female ? Sex.Female : Sex.Male,
                status: female ? Status.Married : null,
                lastAward: null,
            });
            await artist.save();
            members.push(artist);
            await BandEntity_Members.create({ band: smashingPumpkins.toLite(), member: artist.toLite() }).save();
        }

        // Friendships: each member befriends every member of a different sex
        // (Signum's MList<Lite<ArtistEntity>> Friends, a self many-to-many).
        for (const m of members)
            for (const other of members)
                if (other.sex !== m.sex)
                    await ArtistEntity_Friends.create({ artist: m.toLite(), friend: other.toLite() }).save();

        // The band's other awards (Signum's MList<AwardEntity> OtherAwards).
        await BandEntity_OtherAwards.create({ band: smashingPumpkins.toLite(), award: grammy.toLite() }).save();

        // A note whose @implementedByAll target is the band.
        const bandNote = NoteWithDateEntity.create({
            title: "American alternative rock band",
            text: "Formed in 1988, led by Billy Corgan.",
            target: smashingPumpkins,
            otherTarget: null,
            creationTime: new Date("1988-01-01T00:00:00Z"),
            creationDate: Temporal.PlainDate.from("1988-01-01"),
            releaseDate: null,
        });
        await bandNote.save();

        // Labels (Country is a plain reference; Owner a self-lite)
        const virgin = LabelEntity.create({ name: "Virgin", country: usa, owner: null });
        await virgin.save();
        const sony = LabelEntity.create({ name: "Sony", country: japan, owner: virgin.toLite() });
        await sony.save();

        // Albums with owned song rows (Signum's MList<SongEmbedded>) and a single
        // embedded bonus track.
        const siamese = AlbumEntity.create({
            name: "Siamese Dream",
            year: toInt(1993),
            author: smashingPumpkins,
            label: virgin,
            state: AlbumState.Saved,
            bonusTrack: null,
        });
        await siamese.save();
        await addSong(siamese, "Disarm", 0);

        const mellon = AlbumEntity.create({
            name: "Mellon Collie and the Infinite Sadness",
            year: toInt(1995),
            author: smashingPumpkins,
            label: virgin,
            state: AlbumState.Saved,
            bonusTrack: SongEmbedded.create({ name: "Jellybelly", duration: null, seconds: null, index: toInt(0) }),
        });
        await mellon.save();
        await addSong(mellon, "Zero", 0, 123);
        await addSong(mellon, "Tonight, Tonight", 1, 376);

        // Solo artist: Michael Jackson, with a personal award and a friendship.
        const personalAward = PersonalAwardEntity.create({ year: toInt(1983), category: "Best Artist", result: AwardResult.Won });
        await personalAward.save();

        const michael = ArtistEntity.create({
            name: "Michael Jackson",
            dead: true,
            sex: Sex.Male,
            status: Status.Single,
            lastAward: personalAward,
        });
        await michael.save();

        const billy = members.find(m => m.name.includes("Billy Corgan"))!;
        await ArtistEntity_Friends.create({ artist: michael.toLite(), friend: billy.toLite() }).save();

        const thriller = AlbumEntity.create({
            name: "Thriller",
            year: toInt(1982),
            author: michael,
            label: sony,
            state: AlbumState.Saved,
            bonusTrack: SongEmbedded.create({
                name: "Billie Jean",
                duration: Temporal.Duration.from({ minutes: 4, seconds: 54 }),
                seconds: toInt(294),
                index: toInt(0),
            }),
        });
        await thriller.save();
        await addSong(thriller, "Thriller", 0);
        await addSong(thriller, "Beat It", 1);

        // A note about Michael, with a colaborator link (Signum's ColaboratorsMixin).
        const michaelNote = NoteWithDateEntity.create({
            title: "King of Pop",
            text: "Known for Thriller and the Moonwalk.",
            target: michael,
            otherTarget: thriller.toLite(),
            creationTime: new Date("2009-06-25T00:00:00Z"),
            creationDate: Temporal.PlainDate.from("2009-06-25"),
            releaseDate: null,
        });
        await michaelNote.save();
        await NoteWithDateEntity_Colaborators.create({ noteWithDate: michaelNote.toLite(), colaborator: michael.toLite() }).save();

        // Award nominations (+ points, Signum's MList<NominationPointEmbedded>).
        const nomination = AwardNominationEntity.create({
            author: smashingPumpkins.toLite(),
            award: grammy.toLite(),
            year: toInt(2001),
            order: toInt(1),
        });
        await nomination.save();
        await AwardNominationEntity_Points.create({ awardNomination: nomination.toLite(), order: toInt(0), point: toInt(10) }).save();

        await AwardNominationEntity.create({
            author: michael.toLite(),
            award: grammy.toLite(),
            year: toInt(2001),
            order: toInt(2),
        }).save();

        // Config + its award junction (Signum's EmbeddedConfig.Awards MList).
        const config = ConfigEntity.create({
            embeddedConfig: EmbeddedConfigEmbedded.create({ defaultLabel: virgin.toLite() }),
        });
        await config.save();
        await ConfigEntity_Awards.create({ config: config.toLite(), award: grammy.toLite() }).save();

        await createFolders();
    }

    // Persists one owned song row for an album.
    async function addSong(album: AlbumEntity, name: string, index: number, seconds?: number): Promise<void> {
        await AlbumEntity_Songs.create({
            album: album.toLite(),
            order: toInt(index),
            name,
            index: toInt(index),
            seconds: seconds != null ? toInt(seconds) : null,
            duration: seconds != null ? Temporal.Duration.from({ seconds }) : null,
        }).save();
    }

    // Creates a small folder tree, exercising both INSERT (new) and UPDATE
    // (re-saving a renamed/reparented row) paths of save().
    async function createFolders(): Promise<void> {
        const a = FolderEntity.create({ name: "A1", parent: null });
        await a.save();
        const b = FolderEntity.create({ name: "B1", parent: null });
        await b.save();
        const x = FolderEntity.create({ name: "X1", parent: a.toLite() });
        await x.save();

        a.name = "A2";
        await a.save();

        x.parent = b.toLite();
        x.name = "X2";
        await x.save();

        b.name = "B2";
        await b.save();
        // NOT YET: Entity.delete() — the original loader deletes x, b, a here.
    }
}
