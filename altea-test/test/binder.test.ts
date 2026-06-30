import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals";
import { QueryBinder } from "@altea/altea/logic/linq/queryBinder";
import {
    ProjectionExpression, SelectExpression, TableExpression, ColumnExpression,
    JoinExpression,
} from "@altea/altea/logic/linq/expressions.sql";
import { QueryFormatter } from "@altea/altea/logic/linq/queryFormatter";
import { AggregateRewriter } from "@altea/altea/logic/linq/visitors/AggregateRewriter";
import { CallExpression, PropertyExpression, ObjectExpression } from "@altea/altea/logic/linq/expressions";
import { expressionSimplifier } from "@altea/altea/logic/linq/visitors/expressionSimplifier";
import { SchemaBuilder } from "@altea/altea/logic/schema";
import { Connector } from "@altea/altea/logic/connection/connector";
import { MusicLogic } from "../logic/MusicLogic";
import { AlbumEntity, LabelEntity, SongEmbedded, ArtistEntity, NoteWithDateEntity } from "../entities/music";

// A connector that returns canned rows instead of hitting a database, so the
// full format→execute→project pipeline can be tested offline.
class FakeConnector extends Connector {
    constructor(schema: any, public rows: unknown[]) { super(schema, false, 128); }
    override executeQuery(): Promise<unknown[]> { return Promise.resolve(this.rows); }
    openConnection(): Promise<any> { throw new Error("not used"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}

// Step-2 smoke test: the QueryBinder turns the source Expression AST into a
// DbExpression ProjectionExpression. Runs WITHOUT a database — binding only
// reads the schema (no SQL executes). Builds the Music schema once in-memory.

const sb = new SchemaBuilder();
sb.settings.isPostgres = false;
MusicLogic.start(sb);
sb.complete();

function bind(query: { expression: any }): ProjectionExpression {
    const simplified = expressionSimplifier()(query.expression);
    return new QueryBinder(sb.schema, false).bindQuery(simplified);
}

// A second schema/binder on the Postgres dialect, so function-selection that
// diverges per dialect (strpos vs CHARINDEX, substr vs SUBSTRING, …) can be
// asserted offline too.
const sbPg = new SchemaBuilder();
sbPg.settings.isPostgres = true;
MusicLogic.start(sbPg);
sbPg.complete();

function bindPg(query: { expression: any }): ProjectionExpression {
    const simplified = expressionSimplifier()(query.expression);
    return new QueryBinder(sbPg.schema, true).bindQuery(simplified);
}

describe("QueryBinder (step 2)", () => {
    test("bare table → Projection over a Select over the Table", () => {
        const proj = bind(table(AlbumEntity));
        assert.ok(proj instanceof ProjectionExpression);
        assert.ok(proj.select instanceof SelectExpression);
        assert.ok(proj.select.from instanceof TableExpression);
        assert.ok(proj.select.columns.length > 0, "table projection should declare columns");
    });

    test("filter → SELECT with a WHERE", () => {
        const proj = bind(table(AlbumEntity).filter(a => a.year < 1995));
        assert.ok(proj instanceof ProjectionExpression);
        assert.notEqual(proj.select.where, undefined, "filter should produce a WHERE");
        assert.ok(proj.select.columns.length > 0);
    });

    test("map to a scalar → single projected column", () => {
        const proj = bind(table(AlbumEntity).filter(a => a.year < 1995).map(a => a.name));
        assert.ok(proj instanceof ProjectionExpression);
        assert.equal(proj.select.columns.length, 1, "scalar projection has exactly one column");
        assert.ok(proj.projector instanceof ColumnExpression, "projector reads one column back");
    });

    test("map to an object literal → one column per member", () => {
        const proj = bind(table(AlbumEntity).map(a => ({ y: a.year, n: a.name })));
        assert.ok(proj instanceof ProjectionExpression);
        assert.equal(proj.select.columns.length, 2);
    });

    test("orderBy → SELECT with ORDER BY", () => {
        const proj = bind(table(AlbumEntity).orderBy(a => a.name));
        assert.equal(proj.select.orderBy.length, 1);
        assert.equal(proj.select.orderBy[0].orderType, "Ascending");
    });

    test("orderByDescending + top → SELECT with TOP over ordered source", () => {
        const proj = bind(table(AlbumEntity).orderByDescending(a => a.year).top(2));
        assert.notEqual(proj.select.top, undefined);
        assert.equal((proj.select.from as SelectExpression).orderBy[0].orderType, "Descending");
    });

    test("thenBy folds into the orderBy select", () => {
        const proj = bind(table(AlbumEntity).orderBy(a => a.year).thenBy(a => a.name));
        assert.equal(proj.select.orderBy.length, 2);
        assert.equal(proj.select.orderBy[0].orderType, "Ascending");
        assert.equal(proj.select.orderBy[1].orderType, "Ascending");
    });

    test("distinct → SELECT DISTINCT", () => {
        const proj = bind(table(AlbumEntity).map(a => a.name).distinct());
        assert.equal(proj.select.isDistinct, true);
        assert.equal(proj.select.columns.length, 1);
    });

    test("string contains in filter binds to LIKE", () => {
        const proj = bind(table(AlbumEntity).filter(a => a.name.contains("Zero")));
        assert.equal(proj.select.where?.kind, "Like");
    });

    test("array contains in filter binds to IN", () => {
        const ids: any[] = [1, 2, 3];
        const proj = bind(table(AlbumEntity).filter(a => ids.contains(a.id)));
        assert.equal(proj.select.where?.kind, "In");
    });

    test("string functions render their SQL-Server form", () => {
        const lower = QueryFormatter.format(bind(table(ArtistEntity).map(a => a.name.toLowerCase())).select, false).sql;
        assert.match(lower, /LOWER\(/i);
        const upper = QueryFormatter.format(bind(table(ArtistEntity).map(a => a.name.toUpperCase())).select, false).sql;
        assert.match(upper, /UPPER\(/i);
        const ltrim = QueryFormatter.format(bind(table(ArtistEntity).map(a => a.name.trimStart())).select, false).sql;
        assert.match(ltrim, /LTRIM\(/i);
        const rtrim = QueryFormatter.format(bind(table(ArtistEntity).map(a => a.name.trimEnd())).select, false).sql;
        assert.match(rtrim, /RTRIM\(/i);
        // substring(start) → SUBSTRING(str, start+1, <big>); substring(start, end) → length = end-start.
        // Synthetic numeric offsets are SqlConstants → inlined as literals (not parameters),
        // so Postgres doesn't see `unknown <op> unknown`.
        const sub1 = QueryFormatter.format(bind(table(ArtistEntity).map(a => a.name.substring(2))).select, false);
        assert.match(sub1.sql, /SUBSTRING\(/i);
        assert.match(sub1.sql, /2147483647/); // no-length substring pads with a large inline length
        const sub2 = QueryFormatter.format(bind(table(ArtistEntity).map(a => a.name.substring(2, 2 + 2))).select, false);
        assert.match(sub2.sql, /SUBSTRING\(/i);
    });

    test("indexOf binds to CHARINDEX (SQL Server) minus one", () => {
        const proj = bind(table(ArtistEntity).filter(a => a.name.indexOf("M") == 0));
        const { sql } = QueryFormatter.format(proj.select, false);
        assert.match(sql, /CHARINDEX\(/i);
        assert.match(sql, /\) - 1\b/); // 1-based SQL → 0-based JS (the "- 1" offset, inlined)
    });

    test("string functions pick the Postgres dialect form", () => {
        const lower = QueryFormatter.format(bindPg(table(ArtistEntity).map(a => a.name.toLowerCase())).select, true).sql;
        assert.match(lower, /lower\(/);
        const sub = QueryFormatter.format(bindPg(table(ArtistEntity).map(a => a.name.substring(2))).select, true).sql;
        assert.match(sub, /substr\(/);
        const idx = QueryFormatter.format(bindPg(table(ArtistEntity).filter(a => a.name.indexOf("M") == 0)).select, true).sql;
        assert.match(idx, /strpos\(/);
    });

    test("Math.sin types via the well-known function registry", () => {
        // Building the query runs fromQuoted; the "<namespace>.<method>" registry gives
        // Math.sin a result type, so this no longer throws "Unexpected object type" at
        // the expression layer. (SQL lowering of Math.* is a separate tier — the binder
        // would still reject it — so we don't bind/execute here.)
        assert.doesNotThrow(() => table(AlbumEntity).map(a => Math.sin(a.year)));
    });

    test("first/single terminals set unique function", () => {
        const q = table(AlbumEntity) as any;
        const first = new CallExpression(new PropertyExpression(q.expression, "first"), [], q.elementType);
        const singleOrNull = new CallExpression(new PropertyExpression(q.expression, "singleOrNull"), [], q.elementType);
        assert.equal(bind({ expression: first }).uniqueFunction, "First");
        assert.equal(bind({ expression: singleOrNull }).uniqueFunction, "SingleOrDefault");
    });

    test("count terminal projects a scalar aggregate", () => {
        const q = table(AlbumEntity) as any;
        const count = new CallExpression(new PropertyExpression(q.expression, "count"), [], q.elementType);
        const proj = bind({ expression: count });
        assert.equal(proj.uniqueFunction, "Single");
        assert.equal(proj.select.columns.length, 1);
        assert.equal(proj.select.columns[0].expression.kind, "Aggregate");
    });
});

describe("QueryFormatter (step 3)", () => {
    test("filter + map renders SELECT/FROM/WHERE with a parameter", () => {
        const proj = bind(table(AlbumEntity).filter(a => a.year < 1995).map(a => a.name));
        const { sql, parameters } = QueryFormatter.format(proj.select, false);
        assert.match(sql, /SELECT/i);
        assert.match(sql, /FROM/i);
        assert.match(sql, /WHERE/i);
        assert.match(sql, /< @p0/); // SQL Server placeholder for the captured 1995
        assert.deepEqual(parameters, [1995]);
    });

    test("postgres dialect uses $1 placeholders", () => {
        const proj = bind(table(AlbumEntity).filter(a => a.year < 1995));
        const { sql } = QueryFormatter.format(proj.select, true);
        assert.match(sql, /\$1/);
        assert.match(sql, /"/); // identifiers double-quoted on postgres
    });

    test("orderBy + top renders ORDER BY and TOP", () => {
        const proj = bind(table(AlbumEntity).orderBy(a => a.name).top(2));
        const { sql } = QueryFormatter.format(proj.select, false);
        assert.match(sql, /TOP 2/i);
        assert.match(sql, /ORDER BY/i);
    });

    test("count renders COUNT aggregate", () => {
        const q = table(AlbumEntity) as any;
        const count = new CallExpression(new PropertyExpression(q.expression, "count"), [], q.elementType);
        const proj = bind({ expression: count });
        const { sql } = QueryFormatter.format(proj.select, false);
        assert.match(sql, /COUNT\(\*\)/i);
    });

    test("distinct renders SELECT DISTINCT", () => {
        const proj = bind(table(AlbumEntity).map(a => a.name).distinct());
        const { sql } = QueryFormatter.format(proj.select, false);
        assert.match(sql, /SELECT DISTINCT/i);
    });

    test("string contains renders LIKE parameter", () => {
        const proj = bind(table(AlbumEntity).filter(a => a.name.contains("Zero")));
        const { sql, parameters } = QueryFormatter.format(proj.select, false);
        assert.match(sql, /LIKE @p0/i);
        assert.deepEqual(parameters, ["%Zero%"]);
    });

    test("array contains renders IN parameters", () => {
        const ids: any[] = [1, 2, 3];
        const proj = bind(table(AlbumEntity).filter(a => ids.contains(a.id)));
        const { sql, parameters } = QueryFormatter.format(proj.select, false);
        assert.match(sql, / IN \(@p0, @p1, @p2\)/i);
        assert.deepEqual(parameters, ids);
    });
});

describe("ProjectionReader end-to-end (step 3, fake connector)", () => {
    test("scalar projection maps rows to values", async () => {
        const q = table(AlbumEntity).map(a => a.name);
        const colName = bind(q).select.columns[0].name; // the SELECT alias for `name`
        const fake = new FakeConnector(sb.schema, [{ [colName]: "Siamese Dream" }, { [colName]: "Zeitgeist" }]);
        const result = await Connector.withConnector(fake, () => q.toArray());
        assert.deepEqual(result, ["Siamese Dream", "Zeitgeist"]);
    });

    test("object projection maps rows to objects", async () => {
        const q = table(AlbumEntity).map(a => ({ y: a.year, n: a.name }));
        const cols = bind(q).select.columns;
        const yKey = cols[0].name, nKey = cols[1].name;
        const fake = new FakeConnector(sb.schema, [{ [yKey]: 1993, [nKey]: "Siamese Dream" }]);
        const result = await Connector.withConnector(fake, () => q.toArray());
        assert.deepEqual(result, [{ y: 1993, n: "Siamese Dream" }]);
    });

    test("count projection maps one aggregate row to a scalar", async () => {
        const q = table(AlbumEntity) as any;
        const count = new CallExpression(new PropertyExpression(q.expression, "count"), [], q.elementType);
        const proj = bind({ expression: count });
        const colName = proj.select.columns[0].name;
        const fake = new FakeConnector(sb.schema, [{ [colName]: 12 }]);
        const result = await Connector.withConnector(fake, () => q.translator.execute(count));
        assert.equal(result, 12);
    });
});

describe("Entity materialisation (step 4, Retriever)", () => {
    // The SELECT alias for the entity's id column, from the bound projector.
    function idColumnName(q: { expression: any }): string {
        return (bind(q).projector as any).externalId.value.name;
    }

    test("whole-entity projection builds instances with a clean snapshot", async () => {
        const q = table(AlbumEntity);
        const proj = bind(q);
        const row: any = {};
        for (const c of proj.select.columns) row[c.name] = null; // null everything…
        row[idColumnName(q)] = 42;                               // …except the id
        const fake = new FakeConnector(sb.schema, [row]);

        const [album] = await Connector.withConnector(fake, () => q.toArray()) as AlbumEntity[];
        assert.ok(album instanceof AlbumEntity, "row materialises to an AlbumEntity");
        assert.equal(album.id, 42);
        assert.equal(album.isNew, false);
        assert.equal(album.isDirty(), false, "a freshly-retrieved entity is not dirty");
    });

    test("reference field → stub entity; nullable embedded honours hasValue", async () => {
        const q = table(AlbumEntity);
        const proj = bind(q);
        const row: any = {};
        for (const c of proj.select.columns) row[c.name] = 7; // non-null everywhere
        row[idColumnName(q)] = 1;
        const fake = new FakeConnector(sb.schema, [row]);

        const [album] = await Connector.withConnector(fake, () => q.toArray()) as AlbumEntity[];
        assert.ok(album.label instanceof LabelEntity, "FK column → a LabelEntity stub");
        assert.equal(album.label.id, 7);
        assert.ok(album.bonusTrack instanceof SongEmbedded, "truthy hasValue → embedded built");
    });
});

describe("Entity navigation → JOIN (step 5)", () => {
    test("map(a => a.label.name) expands to a LEFT OUTER JOIN", () => {
        const proj = bind(table(AlbumEntity).map(a => a.label.name));
        assert.ok(proj.select.from instanceof JoinExpression, "navigation joins the referenced table");
        const join = proj.select.from as JoinExpression;
        assert.equal(join.joinType, "SingleRowLeftOuterJoin");
        assert.ok(join.condition != null, "the join carries an ON condition (FK = pk)");

        const { sql } = QueryFormatter.format(proj.select, false);
        assert.match(sql, /LEFT OUTER JOIN/i);
    });

    test("filter on a navigated field joins and references the joined alias", () => {
        const proj = bind(table(AlbumEntity).filter(a => a.label.name != "x"));
        assert.ok(proj.select.from instanceof JoinExpression);
        const { sql, parameters } = QueryFormatter.format(proj.select, false);
        assert.match(sql, /LEFT OUTER JOIN/i);
        assert.match(sql, /WHERE/i);
        assert.deepEqual(parameters, ["x"]);
    });

    test("navigating the same reference twice produces a single join", () => {
        // both projected fields go through a.label → one LEFT OUTER JOIN only
        const proj = bind(table(AlbumEntity).map(a => ({ n: a.label.name, i: a.label.id })));
        const { sql } = QueryFormatter.format(proj.select, false);
        assert.equal((sql.match(/LEFT OUTER JOIN/gi) ?? []).length, 1);
    });
});

describe("ImplementedBy / ImplementedByAll (SmartEqualizer)", () => {
    // AlbumEntity.author is @implementedBy([ArtistEntity, BandEntity]); each
    // implementation contributes its own nullable FK column to the album table.
    test("projecting an @implementedBy reference selects one id column per implementation", () => {
        const proj = bind(table(AlbumEntity).map(a => a.author));
        const { sql } = QueryFormatter.format(proj.select, false);
        // no JOIN: a projected reference is read by id (the reader picks the
        // populated implementation), so both implementation id columns are selected.
        assert.doesNotMatch(sql, /JOIN/i);
        assert.match(sql, /author_Artist/i);
        assert.match(sql, /author_Band/i);
    });

    // x instanceof ArtistEntity → that implementation's column IS NOT NULL.
    test("instanceof on @implementedBy lowers to an IS NOT NULL on the implementation column", () => {
        const proj = bind(table(AlbumEntity).filter(a => a.author instanceof ArtistEntity));
        const { sql } = QueryFormatter.format(proj.select, false);
        assert.match(sql, /author_Artist\w*\]? IS NOT NULL/i);
        assert.doesNotMatch(sql, /author_Band\w*\]? IS NOT NULL/i);
    });

    // NoteWithDateEntity.target is @implementedByAll: a single id column + a string
    // type discriminator. instanceof compares the discriminator to the clean name.
    test("instanceof on @implementedByAll compares the type discriminator", () => {
        const proj = bind(table(NoteWithDateEntity).filter(n => n.target instanceof AlbumEntity));
        const { sql, parameters } = QueryFormatter.format(proj.select, false);
        assert.match(sql, /targetType/i);
        assert.ok(parameters.includes("Album"), "compares against the clean type name");
    });

    // (x as Concrete) on @implementedBy narrows to that implementation; navigating a
    // field then joins the concrete table.
    test("cast narrows @implementedBy and navigates the concrete table", () => {
        const proj = bind(table(AlbumEntity).map(a => (a.author as ArtistEntity).name));
        const { sql } = QueryFormatter.format(proj.select, false);
        assert.match(sql, /LEFT OUTER JOIN/i);
    });
});

// GroupBy shape (offline). bind() runs the binder only; the group-aggregate path
// emits AggregateRequest nodes that AggregateRewriter hoists into the GROUP BY
// select, so these run that pass before formatting.
describe("GroupBy shape (tier 3)", () => {
    const rewrite = (proj: ProjectionExpression) => AggregateRewriter.rewrite(proj) as ProjectionExpression;

    test("groupBy(key) → GROUP BY clause + a { key, elements } projector", () => {
        const proj = bind(table(ArtistEntity).groupBy(a => a.sex));
        assert.ok(proj.select.groupBy.length === 1, "one group-by key expression");
        assert.ok(proj.projector instanceof ObjectExpression);
        const o = proj.projector as ObjectExpression;
        assert.ok("key" in o.properties && "elements" in o.properties, "grouping exposes key + elements");
        const { sql } = QueryFormatter.format(proj.select, false);
        assert.match(sql, /GROUP BY/i);
    });

    test("aggregate over a group hoists into the GROUP BY select as a column", () => {
        const proj = rewrite(bind(
            table(ArtistEntity).groupBy(a => a.sex, a => a.name.length).map(g => ({ key: g.key, sum: g.elements.sum() }))));
        const { sql } = QueryFormatter.format(proj.select, false);
        assert.match(sql, /GROUP BY/i);
        assert.match(sql, /SUM\(/i, "the group's sum is hoisted into a SUM(...) column");
        assert.doesNotMatch(proj.toString(), /AggregateRequest/, "no AggregateRequest survives the rewrite");
    });

    test("a constant in the group key uses one parameter across SELECT and GROUP BY", () => {
        const proj = rewrite(bind(
            table(AlbumEntity).groupBy(a => a.year < 2000 ? a.label : null).map(g => ({ k: g.key, c: g.elements.length }))));
        // Postgres: the same constant must render as the same $n in SELECT and GROUP BY.
        const { sql, parameters } = QueryFormatter.format(proj.select, true);
        assert.match(sql, /GROUP BY/i);
        assert.equal(parameters.filter(p => p === 2000).length, 1, "the 2000 literal is parameterised once");
    });
});

// Join shape (offline) — each relational-join operator picks its SQL join type
// (innerJoin/leftJoin/rightJoin/fullJoin); leftJoin preserves the outer source,
// rightJoin the inner, fullJoin both.
describe("Join shape (tier 3)", () => {
    test("innerJoin → INNER JOIN", () => {
        const proj = bind(table(AlbumEntity).innerJoin(table(AlbumEntity), a => a.year, b => b.year, (a, b) => ({ x: a.name, y: b.name })));
        const { sql } = QueryFormatter.format(proj.select, false);
        assert.match(sql, /INNER JOIN/i);
    });

    test("leftJoin → LEFT OUTER JOIN", () => {
        const proj = bind(table(AlbumEntity).leftJoin(table(AlbumEntity), a => a.year, b => b!.year, (a, b) => ({ x: a.name })));
        const { sql } = QueryFormatter.format(proj.select, false);
        assert.match(sql, /LEFT OUTER JOIN/i);
    });

    test("rightJoin → RIGHT OUTER JOIN", () => {
        const proj = bind(table(AlbumEntity).rightJoin(table(AlbumEntity), a => a!.year, b => b.year, (a, b) => ({ y: b.name })));
        const { sql } = QueryFormatter.format(proj.select, false);
        assert.match(sql, /RIGHT OUTER JOIN/i);
    });

    test("fullJoin → FULL OUTER JOIN", () => {
        const proj = bind(table(AlbumEntity).fullJoin(table(AlbumEntity), a => a!.year, b => b!.year, (a, b) => ({ x: a!.name })));
        const { sql } = QueryFormatter.format(proj.select, false);
        assert.match(sql, /FULL OUTER JOIN/i);
    });
});
