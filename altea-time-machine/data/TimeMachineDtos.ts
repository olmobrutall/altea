import type { Entity } from "@altea/altea/data/entity";

/** One version of a row, plus its dump (Serializer.dump). */
export interface EntityDump {
    entity: Entity;
    dump: string;
}
