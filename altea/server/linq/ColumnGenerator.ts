import { Expression } from "./expressions";
import { ColumnDeclaration, ColumnExpression } from "./expressions.sql";

export class ColumnGenerator {
    private readonly columns = new Map<string, ColumnDeclaration>();
    private iColumn = 0;

    // Optionally seed with existing declarations (Signum's
    // `ColumnGenerator(IEnumerable<ColumnDeclaration>)`), so newly mapped columns
    // get names unique against the ones already present. Used by QueryRebinder.
    constructor(seed?: readonly ColumnDeclaration[]) {
        if (seed != null)
            for (const cd of seed)
                this.columns.set(cd.name.toLowerCase(), cd);
    }

    get declarations(): ColumnDeclaration[] {
        return [...this.columns.values()];
    }

    private getUniqueColumnName(name: string): string {
        let candidate = name;
        let suffix = 1;
        while (this.columns.has(candidate.toLowerCase()))
            candidate = name + (suffix++);
        return candidate;
    }

    private getNextColumnName(): string {
        return this.getUniqueColumnName("c" + (this.iColumn++));
    }

    mapColumn(ce: ColumnExpression): ColumnDeclaration {
        const name = this.getUniqueColumnName(ce.name ?? "c");
        const cd = new ColumnDeclaration(name, ce);
        this.columns.set(name.toLowerCase(), cd);
        return cd;
    }

    newColumn(exp: Expression): ColumnDeclaration {
        const name = this.getNextColumnName();
        const cd = new ColumnDeclaration(name, exp);
        this.columns.set(name.toLowerCase(), cd);
        return cd;
    }
}
