import { int, Temporal, toInt } from "@altea/altea/entities/basics";
import "@altea/altea/logic/saver"; // installs Entity.prototype.save() (graph saver)
import {
    CountryEntity,
    LabelEntity,
    ArtistEntity,
    ArtistEntity_Friends,
    BandEntity,
    BandEntity_Members,
    GrammyAwardEntity,
    AmericanMusicAwardEntity,
    PersonalAwardEntity,
    AlbumEntity,
    AlbumEntity_Songs,
    SongEmbedded,
    AwardNominationEntity,
    ConfigEntity,
    ConfigEntity_Awards,
    EmbeddedConfigEmbedded,
    NoteWithDateEntity,
    ColaboratorsMixin,
    NoteWithDateEntity_Colaborators,
    FolderEntity,
    Sex,
    Status,
    AwardResult,
    AlbumState,
} from "../entities/music";

// Port of Signum.Test's MusicLoader, kept as close to the C# original as the
// implemented feature set allows. Differences:
//   - `.Execute(XOperation.Save)` → `.save()` (operations aren't modelled yet);
//     save() returns the entity, so the same inline-chaining style is preserved.
//   - Signum MLists become "part" collections: build the rows, assign them to the
//     owner's collection, and save the OWNER only — the parts are persisted with
//     it (cascade is future work, so we don't .save() the part rows here).
//   - NOT YET: SqlHierarchyId Node, CorruptMixin, Entity.delete().

// Builds an ArtistEntity from a name (sex/status inferred as in the C# loader).
function artist(name: string): ArtistEntity {
    const female = name.includes("Wretzky");
    return ArtistEntity.create({
        name,
        dead: false,
        sex: female ? Sex.Female : Sex.Male,
        status: female ? Status.Married : null,
        lastAward: null,
    });
}

export namespace MusicLoader {
    export async function load(): Promise<void> {
        const ama = await AmericanMusicAwardEntity.create({ category: "Indie Rock", year: toInt(1991), result: AwardResult.Nominated }).save();

        const members = "Billy Corgan, James Iha, D'arcy Wretzky, Jimmy Chamberlin".split(",").map(s => artist(s.trim()));
        const smashingPumpkins = await BandEntity.create({
            name: "Smashing Pumpkins",
            members: members.map(a => BandEntity_Members.create({ member: a.toLite(true) })),
            lastAward: ama,
        }).save();

        const usa = CountryEntity.create({ name: "USA" });
        const japan = CountryEntity.create({ name: "Japan" });

        // Each member befriends every member of a different sex (a self
        // many-to-many; fat lites because the artists are new).
        members.forEach(m => {
            m.friends = members.filter(a => a.sex !== m.sex).map(a => ArtistEntity_Friends.create({ friend: a.toLite(true) }));
        });
        await smashingPumpkins.save();

        await NoteWithDateEntity.create({
            releaseDate: Temporal.Now.plainDateISO(),
            creationTime: Temporal.Now.plainDateTimeISO(),
            creationDate: Temporal.Now.plainDateISO(),
            target: smashingPumpkins,
            otherTarget: null,
            title: "American alternative rock band",
            text: "The Smashing Pumpkins are an alternative rock band formed in 1988, led by Billy Corgan.",
        }).save();

        const virgin = await LabelEntity.create({ name: "Virgin", country: usa, owner: null }).save();

        await AlbumEntity.create({ state: AlbumState.Saved,
            name: "Siamese Dream",
            year: toInt(1993),
            author: smashingPumpkins,
            songs: AlbumEntity_Songs.createMany([{ name: "Disarm" }]),
            bonusTrack: null,
            label: virgin,
        }).save();

        const mellon = await AlbumEntity.create({ state: AlbumState.Saved,
            name: "Mellon Collie and the Infinite Sadness",
            year: toInt(1995),
            author: smashingPumpkins,
            songs: AlbumEntity_Songs.createMany([
                { name: "Zero", duration: Temporal.Duration.from({ seconds: 123 }) },
                { name: "1976" },
                { name: "Tonight, Tonight", duration: Temporal.Duration.from({ seconds: 376 }) },
            ]),
            bonusTrack: SongEmbedded.create({ name: "Jellybelly", duration: null, seconds: null, index: toInt(0) }),
            label: virgin,
        }).save();

        await NoteWithDateEntity.create({
            creationTime: Temporal.Now.plainDateTimeISO(),
            creationDate: Temporal.Now.plainDateISO(),
            releaseDate: null,
            target: mellon,
            otherTarget: null,
            title: "The blue one with the angel",
            text: "Mellon Collie and the Infinite Sadness is a sprawling 1995 double album by The Smashing Pumpkins.",
        }).save();

        const wea = await LabelEntity.create({ name: "WEA International", country: usa, owner: virgin.toLite() }).save();

        await AlbumEntity.create({ state: AlbumState.Saved,
            name: "Zeitgeist",
            year: toInt(2007),
            author: smashingPumpkins,
            songs: AlbumEntity_Songs.createMany([{ name: "Tarantula" }]),
            bonusTrack: SongEmbedded.create({ name: "1976", duration: null, seconds: null, index: toInt(0) }),
            label: wea,
        }).save();

        await AlbumEntity.create({ state: AlbumState.Saved,
            name: "American Gothic",
            year: toInt(2008),
            author: smashingPumpkins,
            songs: AlbumEntity_Songs.createMany([{ name: "The Rose March", duration: Temporal.Duration.from({ seconds: 276 }) }]),
            bonusTrack: null,
            label: wea,
        }).save();

        const pa = await PersonalAwardEntity.create({ category: "Best Artist", year: toInt(1983), result: AwardResult.Won }).save();

        const billy = members.find(a => a.name.includes("Billy Corgan"))!;
        const michael = await ArtistEntity.create({
            name: "Michael Jackson",
            dead: true,
            sex: Sex.Male,
            status: Status.Single,
            lastAward: pa,
            friends: [ArtistEntity_Friends.create({ friend: billy.toLite(true) })],
        }).save();

        await NoteWithDateEntity.create({
            creationTime: Temporal.PlainDateTime.from("2009-06-25T00:00:00"),
            creationDate: Temporal.PlainDate.from("2009-06-25"),
            releaseDate: null,
            target: michael,
            otherTarget: null,
            title: "Death on June, 25th",
            text: "Michael Jackson, the \"King of Pop\", known for Thriller and the Moonwalk.",
        }).save();

        await NoteWithDateEntity.create({
            creationTime: Temporal.PlainDateTime.from("2010-06-25T00:00:00"),
            creationDate: Temporal.PlainDate.from("2010-06-25"),
            releaseDate: null,
            target: michael,
            otherTarget: null,
            title: "Member of The Jackson 5 Pop band",
            text: "The Jackson 5 was a Motown family band that rose to fame in the late 1960s.",
        }).save();

        // A note with a colaborator (Signum's ColaboratorsMixin) added inline.
        // NOT YET: .setMixin(CorruptMixin, c => c.corrupt, true). Title omitted (null).
        const corruptNote = NoteWithDateEntity.create({
            creationTime: Temporal.PlainDateTime.from("2000-01-01T00:00:00"),
            creationDate: Temporal.PlainDate.from("2000-01-01"),
            releaseDate: null,
            target: michael,
            otherTarget: null,
        });
        corruptNote.mixin(ColaboratorsMixin).colaborators = [
            NoteWithDateEntity_Colaborators.create({ colaborator: michael.toLite() }),
        ];
        await corruptNote.save();

        const universal = await LabelEntity.create({ name: "UMG Recordings", country: usa, owner: null }).save();

        await AlbumEntity.create({ state: AlbumState.Saved,
            name: "Ben",
            year: toInt(1972),
            author: michael,
            songs: AlbumEntity_Songs.createMany([{ name: "Ben" }]),
            bonusTrack: SongEmbedded.create({ name: "Michael", duration: null, seconds: null, index: toInt(0) }),
            label: universal,
        }).save();

        const sony = await LabelEntity.create({ name: "Sony", country: japan, owner: null }).save();

        await AlbumEntity.create({ state: AlbumState.Saved,
            name: "Thriller",
            year: toInt(1982),
            author: michael,
            songs: AlbumEntity_Songs.createMany([{ name: "Wanna Be Startin' Somethin'" }, { name: "Thriller" }, { name: "Beat It" }]),
            bonusTrack: SongEmbedded.create({ name: "Billie Jean", duration: null, seconds: null, index: toInt(0) }),
            label: sony,
        }).save();

        const mjj = await LabelEntity.create({ name: "MJJ", country: usa, owner: sony.toLite() }).save();

        await AlbumEntity.create({ state: AlbumState.Saved,
            name: "Bad",
            year: toInt(1989),
            author: michael,
            songs: AlbumEntity_Songs.createMany([{ name: "Bad" }, { name: "Man in the Mirror" }, { name: "Dirty Diana" }, { name: "Smooth Criminal" }]),
            bonusTrack: null,
            label: mjj,
        }).save();

        await AlbumEntity.create({ state: AlbumState.Saved,
            name: "Dangerous",
            year: toInt(1991),
            author: michael,
            songs: AlbumEntity_Songs.createMany([{ name: "Black or White" }, { name: "Who Is It" }, { name: "Give it to Me" }]),
            bonusTrack: null,
            label: mjj,
        }).save();

        await AlbumEntity.create({ state: AlbumState.Saved,
            name: "HIStory",
            year: toInt(1995),
            author: michael,
            songs: AlbumEntity_Songs.createMany([{ name: "Billie Jean" }, { name: "Stranger In Moscow" }]),
            bonusTrack: SongEmbedded.create({ name: "Heal The World", duration: null, seconds: null, index: toInt(0) }),
            label: mjj,
        }).save();

        await AlbumEntity.create({ state: AlbumState.Saved,
            name: "Blood on the Dance Floor",
            year: toInt(1995),
            author: michael,
            songs: AlbumEntity_Songs.createMany([{ name: "Blood on the Dance Floor" }, { name: "Morphine" }]),
            bonusTrack: null,
            label: mjj,
        }).save();

        const ga = await GrammyAwardEntity.create({ category: "Foreign Band", year: toInt(2001), result: AwardResult.Won }).save();

        // Sigur Ros' members are saved first (mirrors the C# loader's per-artist
        // Execute), then referenced from the band's member collection.
        const sigurMembers: ArtistEntity[] = [];
        for (const name of "Jón Þór Birgisson, Georg Hólm, Orri Páll Dýrason".split(","))
            sigurMembers.push(await artist(name.trim()).save());

        const sigurRos = await BandEntity.create({
            name: "Sigur Ros",
            members: sigurMembers.map(a => BandEntity_Members.create({ member: a.toLite() })),
            lastAward: ga,
        }).save();

        const fatCat = await LabelEntity.create({ name: "FatCat Records", country: usa, owner: universal.toLite() }).save();

        await AlbumEntity.create({ state: AlbumState.Saved,
            name: "Ágaetis byrjun",
            year: toInt(1999),
            author: sigurRos,
            songs: AlbumEntity_Songs.createMany([{ name: "Scefn-g-englar" }]),
            bonusTrack: SongEmbedded.create({ name: "Intro", duration: null, seconds: null, index: toInt(0) }),
            label: fatCat,
        }).save();

        const emi = await LabelEntity.create({ name: "EMI", country: usa, owner: null }).save();

        await AlbumEntity.create({ state: AlbumState.Saved,
            name: "Takk...",
            year: toInt(2005),
            author: sigurRos,
            songs: AlbumEntity_Songs.createMany([{ name: "Hoppípolla" }, { name: "Glósóli" }, { name: "Saeglópur" }]),
            bonusTrack: SongEmbedded.create({ name: "Svo hljótt", duration: null, seconds: null, index: toInt(0) }),
            label: emi,
        }).save();

        await AwardNominationEntity.create({ author: sigurRos.toLite(), award: ga.toLite() }).save();
        await AwardNominationEntity.create({ author: michael.toLite(), award: ga.toLite() }).save();
        await AwardNominationEntity.create({ author: smashingPumpkins.toLite(), award: ga.toLite() }).save();

        await AwardNominationEntity.create({ author: sigurRos.toLite(), award: ama.toLite() }).save();
        await AwardNominationEntity.create({ author: michael.toLite(), award: ama.toLite() }).save();
        await AwardNominationEntity.create({ author: smashingPumpkins.toLite(), award: ama.toLite() }).save();

        await AwardNominationEntity.create({ author: michael.toLite(), award: pa.toLite() }).save();
        // C# also adds one with a null award (its NotNullValidator is disabled).
        await AwardNominationEntity.create({ author: michael.toLite(), award: null! }).save();

        await ConfigEntity.create({
            embeddedConfig: EmbeddedConfigEmbedded.create({ defaultLabel: null }),
            awards: [ConfigEntity_Awards.create({ award: ga.toLite() })],
        }).save();

        await createFolders();
    }

    // Creates a small folder tree, exercising both INSERT (new) and UPDATE
    // (re-saving a renamed/reparented row) paths of save().
    async function createFolders(): Promise<void> {
        const a = await FolderEntity.create({ name: "A1", parent: null }).save();
        const b = await FolderEntity.create({ name: "B1", parent: null }).save();
        const x = await FolderEntity.create({ name: "X1", parent: a.toLite() }).save();

        a.name = "A2";
        await a.save();

        x.parent = b.toLite();
        await x.save();

        x.name = "X2";
        await x.save();

        b.name = "B2";
        await b.save();
        // NOT YET: Entity.delete() — the original loader deletes x, b, a here.
    }
}
