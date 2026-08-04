// A dense float vector value (Signum's Pgvector.Vector), backing a `vector(N)` column for
// nearest-neighbour / embedding search. It serialises to the pgvector text format `[1,2,3]`, which
// both pgvector (Postgres) and SQL Server 2025's native VECTOR type accept as an input literal and
// return on read. The dimension N is fixed by the column's @column({ size: N }); a Vector assigned
// to such a column must have exactly N components.
export class Vector {
    readonly values: readonly number[];

    constructor(values: readonly number[] | Float32Array | Float64Array) {
        this.values = values instanceof Float32Array || values instanceof Float64Array ? Array.from(values) : values;
    }

    get dimensions(): number {
        return this.values.length;
    }

    // pgvector / SQL Server VECTOR input+output literal: `[1,2,3]` (no spaces).
    toString(): string {
        return "[" + this.values.join(",") + "]";
    }

    // Parse the `[1,2,3]` literal a vector column returns.
    static parse(text: string): Vector {
        const inner = text.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
        return new Vector(inner.length === 0 ? [] : inner.split(",").map(s => Number(s)));
    }
}
