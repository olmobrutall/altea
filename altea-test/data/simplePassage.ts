import { reflect } from "@altea/altea/data/reflection";
import { entity } from "@altea/altea/data/decorators";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { type int, toInt } from "@altea/altea/data/basics";
import { NoteWithDateEntity } from "./note";

@entity("String", "Master")
export class SimplePassageEntity extends Entity {
    note: Lite<NoteWithDateEntity>;
    isTitle: boolean;
    // NOT YET: Vector? Embedding (pgvector unsupported)
    chunk: string;
    index: int = toInt(0); // C# value-type default (0); the loader relies on it
}
