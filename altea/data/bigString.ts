import { EmbeddedEntity } from "./entity";
import { MAX_SIZE, reflect } from "./reflection";
import { column } from "./decorators";

// Port of Signum's BigStringEmbedded (old/Framework/Signum/Entities/BigString.cs). An embedded wrapper
// around a single unbounded (nvarchar(MAX) / varchar) `text` column. It exists as an extension point:
// an extension (Signum.Files' BigStringMixin) can redirect the text to file/blob storage transparently.
//
// Signum note preserved: to save the redundant HasValue column the EMBEDDED is kept non-nullable while
// its `text` is nullable — so an owner declares `stackTrace: BigStringEmbedded = ...` (always present),
// and emptiness is `text == null`.
@reflect
export class BigStringEmbedded extends EmbeddedEntity {
    // Signum's `[DbType(Size = int.MaxValue)]`. Said explicitly because a string column with no size now
    // takes the per-provider DEFAULT of 200 (SchemaSettings.defaultSize*) — and a column that is NOT that
    // is the entire reason this type exists.
    @column({ size: MAX_SIZE })
    text: string | null = null;
}
