// Scoped port of Signum's Signum.Utilities/StringDistance.cs — only the LevenshteinDistance
// path that Replacements.askForReplacements needs (weighted edit distance for ranking rename
// candidates). The full Choices/Diff/LCS machinery is omitted.

export enum ChoiceType {
    Equal = 'Equal',
    Substitute = 'Substitute',
    Remove = 'Remove',
    Add = 'Add',
    Transpose = 'Transpose',
}

export interface Choice<T> {
    readonly type: ChoiceType;
    readonly removed: T;
    readonly added: T;
}

function add<T>(value: T): Choice<T> { return { type: ChoiceType.Add, removed: undefined as T, added: value }; }
function remove<T>(value: T): Choice<T> { return { type: ChoiceType.Remove, removed: value, added: undefined as T }; }
function substitute<T>(removed: T, added: T): Choice<T> { return { type: ChoiceType.Substitute, removed, added }; }
function transpose<T>(removed: T, added: T): Choice<T> { return { type: ChoiceType.Transpose, removed, added }; }

export class StringDistance {
    // Weighted Levenshtein distance between two strings. `weight` costs each edit by its
    // Choice type (Replacements weights a substitution as 2, everything else as 1).
    levenshteinDistance(
        strOld: string,
        strNew: string,
        weight: (c: Choice<string>) => number = () => 1,
        allowTransposition = false,
    ): number {
        const a = [...strOld];
        const b = [...strNew];
        const M1 = a.length + 1;
        const M2 = b.length + 1;

        // num[i][j]
        const num: number[][] = Array.from({ length: M1 }, () => new Array<number>(M2).fill(0));

        num[0][0] = 0;

        for (let i = 1; i < M1; i++)
            num[i][0] = num[i - 1][0] + weight(remove(a[i - 1]));
        for (let j = 1; j < M2; j++)
            num[0][j] = num[0][j - 1] + weight(add(b[j - 1]));

        for (let i = 1; i < M1; i++) {
            for (let j = 1; j < M2; j++) {
                if (a[i - 1] === b[j - 1]) {
                    num[i][j] = num[i - 1][j - 1];
                } else {
                    num[i][j] = Math.min(
                        Math.min(
                            num[i - 1][j] + weight(remove(a[i - 1])),
                            num[i][j - 1] + weight(add(b[j - 1]))),
                        num[i - 1][j - 1] + weight(substitute(a[i - 1], b[j - 1])));

                    if (allowTransposition && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
                        num[i][j] = Math.min(num[i][j], num[i - 2][j - 2] + weight(transpose(a[i - 1], a[i - 2])));
                }
            }
        }

        return num[M1 - 1][M2 - 1];
    }
}
