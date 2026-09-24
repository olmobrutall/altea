import { test, beforeAll, describe } from "vitest";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import { Temporal } from "@altea/altea/data/basics";
import { Clock, TimeZoneMode } from "@altea/altea/data/utils/clock";
import { Connector } from "@altea/altea/server/connection/connector";
import { denormalizeTemporal } from "@altea/altea/server/normalizeScalar";
import { hasDb, start } from "../setup";
import { NoteWithDateEntity } from "../../data/note";

// A UTC clock (the default) stores a PlainDateTime as `timestamptz` on Postgres, as Signum's
// Schema.TimeZoneMode does, with the session pinned to UTC so every conversion happens in the clock's frame.

describe("Clock user-interface conversion", () => {
    const utc = Temporal.PlainDateTime.from("2024-07-01T10:00:00");

    test("Utc shifts to the user's zone and back", () => {
        Clock.withTimeZone("Europe/Berlin", () => {
            const ui = Clock.toUserInterface(utc);
            assert.equal(ui.toString(), "2024-07-01T12:00:00"); // CEST, +02:00
            assert.equal(Clock.fromUserInterface(ui).toString(), utc.toString());
        });
    });

    test("Local leaves the value alone", () => {
        const old = Clock.mode;
        Clock.mode = TimeZoneMode.Local;
        try {
            Clock.withTimeZone("Europe/Berlin", () => {
                assert.equal(Clock.toUserInterface(utc).toString(), utc.toString());
                assert.equal(Clock.fromUserInterface(utc).toString(), utc.toString());
            });
        } finally {
            Clock.mode = old;
        }
    });
});

describe("timestamptz text", () => {
    test("an offset is resolved to the UTC wall time", () => {
        assert.equal(String(denormalizeTemporal("2024-06-01 10:00:00+00", "dateTime")), "2024-06-01T10:00:00");
        assert.equal(String(denormalizeTemporal("2024-06-01 10:00:00.5+02", "dateTime")), "2024-06-01T08:00:00.5");
        assert.equal(String(denormalizeTemporal("2024-06-01 10:00:00+05:30", "dateTime")), "2024-06-01T04:30:00");
        assert.equal(String(denormalizeTemporal("2024-06-01 10:00:00.123456", "dateTime")), "2024-06-01T10:00:00.123456");
    });
});

describe.skipIf(!hasDb)("UTC clock on the database", () => {
    beforeAll(async () => { await start(); });

    test("the column is timestamptz and the session is UTC (Postgres)", async ({ skip }) => {
        const connector = Connector.current();
        if (!connector.isPostgres)
            skip();

        const [zone] = await connector.executeQuery("SHOW TimeZone") as { TimeZone: string }[];
        assert.equal(zone.TimeZone, "UTC");

        const [column] = await connector.executeQuery(
            "SELECT data_type FROM information_schema.columns WHERE table_name = 'note_with_date' AND column_name = 'creation_time'") as { data_type: string }[];
        assert.equal(column.data_type, "timestamp with time zone");
    });

    test("a stored value round-trips, filters and extracts in UTC", async () => {
        const june25 = Temporal.PlainDateTime.from("2009-06-25T00:00:00");

        const notes = await table(NoteWithDateEntity)
            .filter(n => Temporal.PlainDateTime.compare(n.creationTime, june25) == 0)
            .map(n => ({ creationTime: n.creationTime, year: n.creationTime.year, hour: n.creationTime.hour }))
            .toArray();

        assert.equal(notes.length, 1);
        assert.equal(notes[0].creationTime.toString(), june25.toString());
        // Number(): a projected date part comes back as Postgres EXTRACT's `numeric` text — a separate issue.
        assert.equal(Number(notes[0].year), 2009);
        assert.equal(Number(notes[0].hour), 0);
    });
});
