import * as ts from 'typescript';
import * as path from 'path';
import transformerFactory from 'quote-transformer';

export function transformSource(source: string): string {
    // Anchored to THIS PACKAGE, never to process.cwd(): the transformer names the package by walking up
    // to the nearest package.json, so a virtual file placed in the caller's working directory resolves to
    // whatever package that happens to be — "quote-test" when run through `pnpm --filter`, nothing at all
    // from the workspace root (which has no package.json since the test-tiers refactor). The expectations
    // all assert packageName "quote-test", so the file has to live where that is true.
    // import.meta.dirname is src/ at runtime, so one level up is the package root.
    const fileName = path.resolve(import.meta.dirname, '..', '__test__.ts');
    const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true);

    const defaultHost = ts.createCompilerHost({});
    const customHost: ts.CompilerHost = {
        ...defaultHost,
        getSourceFile: (name, languageVersion) => {
            if (path.normalize(name) === path.normalize(fileName))
                return sourceFile;
            return defaultHost.getSourceFile(name, languageVersion);
        },
        fileExists: (name) => path.normalize(name) === path.normalize(fileName) || defaultHost.fileExists(name),
        readFile: (name) => path.normalize(name) === path.normalize(fileName) ? source : defaultHost.readFile(name),
    };

    const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        experimentalDecorators: true,
        skipLibCheck: true,
        strict: false,
    }, customHost);

    const transformer = transformerFactory(program, undefined, {
        ts,
        addDiagnostic: () => 0,
    } as any);

    const result = ts.transform(sourceFile, [transformer]);
    return ts.createPrinter().printFile(result.transformed[0]);
}

export function normalize(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}
