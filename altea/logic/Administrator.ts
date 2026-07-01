// Schema-management operations (Signum's `Administrator`). These act on the database
// schema rather than on data — creating temporary tables/views, resetting sequences, etc.

// Signum's Administrator.CreateTemporaryTable<T>() — materialise a temporary table for a
// `@tableName("#...")` view type, to be populated with executeInsertView. Temporary
// tables / views aren't modelled in altea yet; this is a throwing stub that locks the
// call shape (used by the UnsafeInsertMyView test, which runs red).
export const Administrator = {
    async createTemporaryTable<V>(viewType: new () => V): Promise<void> {
        throw new Error("Administrator.createTemporaryTable (temporary table / view) is not implemented yet");
    },
};
