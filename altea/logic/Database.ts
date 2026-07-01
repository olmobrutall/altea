// Database-level helpers that operate on already-materialised entities/lites (Signum's
// `Database` static). Distinct from the set-based bulk operations on `Query<T>`
// (executeUpdate/Delete/Insert) — these act per-row on an in-memory list.

import { Entity } from "../entities/entity";
import { Lite } from "../entities/lite";

// Signum's Database.DeleteList — delete a list of entities/lites one row at a time (as
// opposed to a set-based `Query<T>.executeDelete()`). Not implemented yet; defined here
// so the call shape is locked and callers compile.
export async function deleteList<T extends Entity>(list: (Lite<T> | T)[]): Promise<void> {
    throw new Error("deleteList (Database.DeleteList — per-row delete of an entity/lite list) is not implemented yet");
}
