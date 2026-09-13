import { describe, test } from "vitest";
import * as assert from 'node:assert/strict';
import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import transformerFactory from 'quote-transformer';

const sourceFilePath = path.resolve(import.meta.dirname, '../examples/codeExamples.source.ts');
const transformedFilePath = path.resolve(import.meta.dirname, '../examples/codeExamples.transformed.ts');
// What the transformer produced THIS run, written only when it differs from the committed file above.
// Re-blessing the example is therefore a rename — you read the diff first, which is the whole point:
// an env var that overwrites the expectation in place is a snapshot nobody ever looks at.
const candidateFilePath = path.resolve(import.meta.dirname, '../examples/codeExamples.transformed.new.ts');

function transformFile(filePath: string): string {
    const program = ts.createProgram([filePath], {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        experimentalDecorators: true,
        skipLibCheck: true,
    });

    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile)
        throw new Error(`Source file not found: ${filePath}`);

    const transformer = transformerFactory(program, undefined, {
        ts,
        addDiagnostic: () => 0,
    } as any);

    const result = ts.transform(sourceFile, [transformer]);
    return ts.createPrinter().printFile(result.transformed[0]);
}

describe('codeExamples', () => {
    test('matches codeExamples.transformed.ts', () => {
        const actual = transformFile(sourceFilePath);
        const expected = fs.readFileSync(transformedFilePath, 'utf8');

        if (actual === expected) {
            // A candidate left over from an earlier failing run is stale the moment this passes, and a
            // stale one is worse than none: it is the wrong output, sitting next to the right one.
            fs.rmSync(candidateFilePath, { force: true });
            return;
        }

        fs.writeFileSync(candidateFilePath, actual, 'utf8');
        console.error(
            `\nThe transformer no longer produces ${path.basename(transformedFilePath)}.\n`
            + `What it produced instead is in ${path.basename(candidateFilePath)} (git-ignored).\n`
            + `If the new output is CORRECT, accept it by renaming over the old one:\n`
            + `    mv examples/${path.basename(candidateFilePath)} examples/${path.basename(transformedFilePath)}\n`);

        // The assertion is for the report: node:assert prints WHICH lines moved, which the message
        // above does not.
        assert.strictEqual(actual, expected);
    });
});
