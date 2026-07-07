import { reflect } from "@altea/altea/entities/reflection";
import { tableName } from "@altea/altea/entities/decorators";
import { View } from "@altea/altea/entities/entity";
import { Lite } from "@altea/altea/entities/lite";
import { ArtistEntity } from "../entities/music";

// Signum's MyTempView — a temporary-table view (its [TableName("#MyTempView")] names the
// SQL Server temp table). A view class = @reflect (Signum's `: IView`) + @tableName; its
// single FK column `artist` is a Lite<ArtistEntity> reference. Unlike a catalog view it
// has NO @viewPrimaryKey (Signum's temp-table views project columns directly and never
// dedup rows, so ViewBuilder synthesizes a representative PK from the first column).
//
// Shared by the UnsafeInsertMyView (unsafeInsert.test.ts) and LeftOuterMyView
// (joinGroup.test.ts) tests so both get the identical schema shape.
@reflect
@tableName("#MyTempView")
export class MyTempView extends View {
    artist!: Lite<ArtistEntity>;
}
