import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { registerEnum } from "@altea/altea/data/reflection";
import { Enum } from "@altea/altea/data/enum";
import { enumEntityMembers } from "@altea/altea/data/enumEntity";

// WHICH members of an enum become rows of its table, and at WHICH ids.
//
// Both halves are stored data rather than code: a member's numeric value IS its row's primary key, and
// every column that references the enum holds one of those keys. So a member that gains, loses or
// changes a value is a data migration — see the renumbering note on the base value below. DB-free.

enum EtColour {
    Red = 1,
    Green,
    Blue,
}
registerEnum(EtColour);

// A state enum whose first member is the state of an object being CREATED — never stored, so never a
// row. Signum spells this `[Ignore]` on the member; altea spells it `Enum.markAsNotMapped`.
enum EtState {
    New,
    Saved,
    Attended,
}
registerEnum(EtState);
Enum.markAsNotMapped(EtState, EtState.New);

const ids = (e: object): Record<string, number> =>
    Object.fromEntries(enumEntityMembers(e).map(m => [m.name, m.id]));

describe("Enum table rows", () => {
    test("one row per member, keyed by the member's own numeric value", () => {
        assert.deepEqual(ids(EtColour), { Red: 1, Green: 2, Blue: 3 });
    });

    test("a member's VALUE is its row id, so the base value is stored data", () => {
        // The point of the assertion above: declaring `Red = 1` rather than letting it default to 0 is
        // what makes these ids 1..3. Getting that wrong against an existing database is not a one-row
        // fix — every member shifts, and since two members cannot hold one id even mid-script, the sync
        // has to shuffle each one through a scratch id and back. `DashboardBehaviour` starting at 0
        // instead of Signum's 1 cost forty statements of exactly that.
        assert.equal(enumEntityMembers(EtColour).find(m => m.name === "Red")!.id, 1);
    });

    test("a not-mapped member gets NO row (Signum's [Ignore])", () => {
        assert.deepEqual(ids(EtState), { Saved: 1, Attended: 2 });
        assert.ok(!("New" in ids(EtState)), "the New state is never stored");
    });

    test("…and keeps its value, so the members that DO have rows are unshifted", () => {
        // Excluding a member must not renumber the others: `Saved` is still 1 because `New` still
        // occupies 0. This is why Signum leaves the ignored member in the enum rather than deleting it.
        assert.equal(EtState.Saved as number, 1);
        assert.equal(ids(EtState)["Saved"], 1);
    });
});
