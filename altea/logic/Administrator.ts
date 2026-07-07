// Schema-management operations (Signum's `Administrator`). These act on the database
// schema rather than on data — creating temporary tables/views, resetting sequences, etc.

import { Connector } from "./connection/connector";
import type { Entity, Type, View, ViewType } from "../entities/entity";

// Signum's Administrator.CreateTemporaryTable<T>() — materialise a SQL Server temp table
// for a `@tableName("#...")` view type, to be populated with executeInsert (Signum's
// UnsafeInsertView). Resolves the ViewType to its Table (the same ViewBuilder-built table
// `view(T)` / the insert target uses, so the shapes match), renders its CREATE TABLE via the
// dialect SqlBuilder, and runs the DDL on the CURRENT connection.
//
// Temp tables are connection-scoped; inside a Transaction (e.g. a txTest's
// Transaction.noCommit) the connection is pinned, so this CREATE, the subsequent INSERT
// and any SELECT all share it and see the same temp table.
export const Administrator = {
    async createTemporaryTable<V extends View>(viewType: ViewType<V>): Promise<void> {
        const connector = Connector.current();
        const table = connector.schema.view(viewType as unknown as Type<Entity>);
        const create = connector.sqlBuilder.createTableSql(table);
        await create.executeNonQuery();
    },
};
