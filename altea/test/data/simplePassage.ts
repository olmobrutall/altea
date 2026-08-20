import { reflect } from "@altea/altea/data/reflection";
import { entity, column, vectorIndex } from "@altea/altea/data/decorators";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { type int, toInt } from "@altea/altea/data/basics";
import { Vector } from "@altea/altea/data/vector";
import { NoteWithDateEntity } from "./note";

@entity("String", "Master")
// Vector index over the 768-dim embedding (Signum's MusicLogic.WithVectorIndex(a => a.Embedding)).
@vectorIndex<SimplePassageEntity>(a => a.embedding)
export class SimplePassageEntity extends Entity {
    note: Lite<NoteWithDateEntity>;
    isTitle: boolean;
    // A pgvector / SQL Server VECTOR(768) column (Signum's [DbType(Size=768)] Vector? Embedding).
    @column({ pgDbType: "vector", sqlDbType: "vector", size: 768, nullable: true })
    embedding: Vector | null;
    chunk: string;
    index: int = toInt(0); // C# value-type default (0); the loader relies on it
}
