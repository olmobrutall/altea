import { EmbeddedEntity } from "./entity";
import { reflect } from "./reflection";

// Port of Signum's BigStringEmbedded (old/Framework/Signum/Entities/BigString.cs). An embedded wrapper
// around a single unbounded (nvarchar(MAX) / varchar) `text` column. It exists as an extension point:
// an extension (Signum.Files' BigStringMixin) can redirect the text to file/blob storage transparently.
//
// Signum note preserved: to save the redundant HasValue column the EMBEDDED is kept non-nullable while
// its `text` is nullable — so an owner declares `stackTrace: BigStringEmbedded = ...` (always present),
// and emptiness is `text == null`.
@reflect
export class BigStringEmbedded extends EmbeddedEntity {
    text: string | null = null;
}
