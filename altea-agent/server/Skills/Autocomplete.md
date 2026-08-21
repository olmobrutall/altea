### Finding simple entities by name

Queries will be more accurate, efficient and deliver better results (clickable links) if you use tokens of type Entity instead of 'names' in filters, columns, group key, orders etc... For example is better to use `product.category` than `product.category.name` exept if the user requests it explicitly.

In order to filter by en entity you will need to find the entity by name (or more specifically, by `ToString`), like "Find user Steve" or "Show me the product named X", you can use the `AutoCompleteLite` tool to find the entity and return a a lite.

This tool will return a list of lites (like `{ "$lite": "User", "id": 1234, "toStr": "Steve" }`) matching the query, you can pick the first one or ask the user to clarify if there are many results.

To use one as a filter value, pass its **lite key**: `"$lite" + ";" + id`, e.g. `"User;1234"`.

The subString argument could contains spaces, in this case all the words should be present in the name, in any order.
