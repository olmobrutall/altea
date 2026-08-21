### Get TypeInfo

The tool `GetTypeInfo` returns the metadata for a type: its localized names, its fields, and the operations defined for it.

IMPORTANT: Always call `GetTypeInfo` for the type you want to operate on, to understand the operations available and the structure of the entity.

The `fields` dictionary is keyed by PROPERTY PATH:
* `"someField"` — a field of the explored entity.
* `"someEmbedded.someField"` — a field inside an embedded entity. An embedded type also gets its OWN entry in the metadata, which is where its translations live.
* `"someCollection.someField"` — a field of the row type of a collection.

Each entry carries, among other things, the field's localized `niceName`, whether it is a collection, whether it is a reference (and to which types), and — per your role — whether you may read or write it.

### Entity JSON

altea's wire format uses two discriminators:

* `"$type": "<CleanTypeName>"` on an ENTITY or an EMBEDDED (the clean name, i.e. without the `Entity` suffix).
* `"$lite": "<CleanTypeName>"` on a LITE (a lightweight reference), plus `id` and `toStr`.

```json
{
  "$type": "Book",
  "id": 101,
  "ticks": 3,
  "toStr": "Refactoring Recipes",
  "title": "Refactoring Recipes",
  "isbn": "978-1-23456-789-0",
  "publishYear": 2024,
  "isPublished": true,
  "publisher": { "$lite": "Publisher", "id": 5, "toStr": "Acme Press" },
  "dimensions": { "$type": "DimensionsEmbedded", "width": 24.0, "height": 17.0 },
  "tags": ["refactoring", "patterns"],
  "chapters": [
    { "$type": "Book_Chapter", "id": 10, "title": "Introduction", "pageCount": 12 }
  ]
}
```

### Key rules

* Member names are **camelCase**; the `$type` / `$lite` values are the PascalCase clean type name.
* `ticks` must be preserved on an existing entity — it is the optimistic-concurrency stamp, and dropping it makes your save overwrite someone else's.
* A NEW entity omits `id` (and `ticks`).
* **A collection is a plain ARRAY.** There is no row wrapper: a collection of values is an array of values, and a collection of rows is an array of objects with their own `$type` (and an `id` for an existing row, omitted for a new one). This differs from other frameworks that wrap each item in `{ rowId, element }` — do not do that here.
* You do not need to set any `modified` flag: the server compares the entity you send against the stored one.
* `toStr` is server-generated; send it back unchanged if you have it, and omit it on a new entity.

### Quick checklist

1. Call `GetTypeInfo` for the target type (and for any related type you have to fill in).
2. Get the entity with `RetrieveEntity`, which returns exactly the JSON shape to send back.
3. Change only what you mean to change, keeping `$type`, `id` and `ticks`.
4. Execute with `Operation_Execute`, or create first with `Operation_Construct` / `Operation_ConstructFrom`.

The `entityJson` argument of every operation tool is the entity as a JSON **string**.

### Operations

#### Execute an operation on an entity

The tool `Operation_Execute` modifies the state or data of an entity by executing an operation — a SAVE is an operation too (typically `<Type>Operation.Save`).

If the operation accepts modifications, send the modified entity. You only need to send the `entity`, not the `canExecute` dictionary that came with it.

#### Construct

The tool `Operation_Construct` creates a new entity of a given type using a constructor operation (usually named `<TypeName>Operation.Create`). The operation may apply default values or business logic during construction.

Returns an entity pack with the newly created (unsaved) entity and its `canExecute` dictionary. To persist it, follow up with `Operation_Execute` using a save operation.

#### ConstructFrom

The tool `Operation_ConstructFrom` creates a new entity derived from an existing one (e.g. creating an `Order` from a `Customer`, or cloning an entity). The source entity is passed as JSON; the same rules apply.

Returns an entity pack with the newly constructed entity. The source entity is not modified. To persist the result, follow up with `Operation_Execute` using a save operation.

#### ConstructFromMany

The tool `Operation_ConstructFromMany` creates a new entity from SEVERAL existing ones (e.g. a combined shipment from multiple orders). The sources are passed as an array of **lite keys** — `"<type>;<id>"`:

```json
["Order;1", "Order;2"]
```

All lites must be of the same entity type. Returns an entity pack with the newly constructed entity; the sources are not modified.

### Delete

The tool `Operation_Delete` permanently deletes an entity using a delete operation.

Pass the entity as JSON (same rules as `Operation_Execute`). Returns nothing on success.

**This action is irreversible** — always confirm with the user before calling this tool (use the `Confirm` tool if it is available). Check the `canExecute` dictionary from a prior retrieve or execute to verify the delete operation is allowed before attempting it.
