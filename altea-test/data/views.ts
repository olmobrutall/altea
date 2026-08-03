import { reflect } from "@altea/altea/data/reflection";
import { tableName, viewPrimaryKey } from "@altea/altea/data/decorators";
import { View } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import type { int } from "@altea/altea/data/basics";
import { ArtistEntity } from "./artist";

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
