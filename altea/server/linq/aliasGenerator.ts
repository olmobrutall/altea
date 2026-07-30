import { ObjectName } from "../schema/objectName";

// Port of Signum's AliasGenerator.cs. An `Alias` is a SQL source name — either a
// generated/raw string (a derived-table alias like `s0`, or a table abbreviation
// like `a`) or an `ObjectName` (a real table referenced directly in FROM). The
// generator hands out collision-free aliases within one query.

export class Alias {
    // Mutually exclusive: a string name OR an objectName.
    readonly name: string | undefined;
    readonly objectName: ObjectName | undefined;
    readonly isPostgres: boolean;

    private constructor(name: string | undefined, objectName: ObjectName | undefined, isPostgres: boolean) {
        this.name = name;
        this.objectName = objectName;
        this.isPostgres = isPostgres;
    }

    static named(name: string, isPostgres: boolean): Alias {
        return new Alias(name, undefined, isPostgres);
    }

    static table(objectName: ObjectName): Alias {
        return new Alias(undefined, objectName, false);
    }

    equals(other: Alias | undefined): boolean {
        if (other == null)
            return false;
        return this.name === other.name &&
            (this.objectName === other.objectName ||
                (this.objectName != null && other.objectName != null && this.objectName.toString() === other.objectName.toString()));
    }

    toString(): string {
        return this.name ?? this.objectName!.toString();
    }
}

export class AliasGenerator {
    private readonly usedAliases = new Set<string>();
    private selectAliasCount = 0;

    constructor(public readonly isPostgres: boolean) { }

    nextSelectAlias(): Alias {
        return this.getUniqueAlias("s" + (this.selectAliasCount++));
    }

    getUniqueAlias(baseAlias: string): Alias {
        if (!this.usedAliases.has(baseAlias)) {
            this.usedAliases.add(baseAlias);
            return Alias.named(baseAlias, this.isPostgres);
        }

        for (let i = 1; ; i++) {
            const alias = baseAlias + i;
            if (!this.usedAliases.has(alias)) {
                this.usedAliases.add(alias);
                return Alias.named(alias, this.isPostgres);
            }
        }
    }

    table(objectName: ObjectName): Alias {
        return Alias.table(objectName);
    }

    raw(name: string): Alias {
        return Alias.named(name, this.isPostgres);
    }

    // Derives a short alias from a table name: the upper-case letters if any
    // ("AlbumEntity" → "AE"), else the initials of underscore-separated parts
    // ("album_entity" → "ae"), else the first character.
    nextTableAlias(tableName: string): Alias {
        const hasUpper = /[A-Z]/.test(tableName);
        const abv = hasUpper ? (tableName.match(/[A-Z]/g) ?? []).join("") :
            tableName.includes("_") ? tableName.split("_").filter(s => s.length > 0).map(s => s[0]).join("") :
                tableName.substring(0, 1);

        return this.getUniqueAlias(abv);
    }

    cloneAlias(alias: Alias): Alias {
        if (alias.name == null)
            throw new Error("Alias should have a name");
        return this.getUniqueAlias(alias.name + "b");
    }
}
