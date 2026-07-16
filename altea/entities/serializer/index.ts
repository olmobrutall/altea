// Barrel for the JSON entity-graph codec, split out of the former monolithic json.ts.
//
// JSON serialization of the entity graph — the wire format between an altea server and an
// altea React client. Isomorphic and reflection-driven (like ../changes.ts): reads only
// reflection metadata + runtime types, imports nothing from the logic/ (DB) layer, and
// rebuilds real class instances on either end via the type registry.
//
// Public API: the `Serializer` namespace — `Serializer.stringify(obj)` / `Serializer.parse(json)`.
//
// Wire shapes (clean type names as the `$type`/`$lite` discriminators):
//   entity    { "$type": "Album", "id": 1, "ticks": 3, "toStr": "…", "modified": true, …fields }
//   embedded  { "$type": "SongEmbedded", …fields }                       (no id/ticks/toStr)
//   lite      { "$lite": "Artist", "id": 7, "toStr": "…", …custom fields, "entity"?: {…} }
//   collection  plain array of part-entity objects (@backReference/@rowOrder recovered on read)
//   enum        member-name string;  Temporal.*/Decimal  string;  number/string/bool  as-is
//
// writeTypes: "Always" writes every discriminator; "Auto" writes them only for roots and
// @implementedBy(All) references (everything else is inferred from the field's serializer).
//
// Field selection: every reflected field is serialized (including @column(false) ones) EXCEPT
// those marked @serialize(false); `id`/`ticks` are handled specially by EntitySerializer.

export { Serializer } from './graphSerializers';
export { registerCustomLite } from './customLite';
export type { CustomLiteClass } from './customLite';
export type { WriteTypes, SerializeOptions, DeserializeOptions } from './types';
