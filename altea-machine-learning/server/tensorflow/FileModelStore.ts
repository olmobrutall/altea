import type * as tfc from "@tensorflow/tfjs-core";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Persisting a tfjs model to the FILESYSTEM, as a tfjs `IOHandler`.
//
// Why this file exists at all: `@tensorflow/tfjs` ships no filesystem IO. Its built-in handlers are
// browser ones (localStorage, IndexedDB, http), and the `file://` scheme everyone reaches for is
// registered by **@tensorflow/tfjs-node** — the native package this module deliberately does not depend
// on (see TensorFlowNeuralNetworkPredictor's header). Found the direct way: training ran fine and then
// `model.save("file://…")` threw "Cannot find any save handlers for URL".
//
// So the module brings its own, which turns out to be the better arrangement rather than a workaround:
// a model saved here loads identically whether the host is running the CPU backend or has registered
// tfjs-node's native one, because the format is ours rather than the backend's.
//
// The format is ONE self-contained JSON file: the topology and weight specs exactly as tfjs hands them
// over, plus the weight bytes base64-encoded. Deliberately not tfjs's own multi-file layout (a
// `model.json` plus sharded `group1-shard1of3.bin` files with a manifest): a predictor's model is stored
// and moved as a unit, and one file cannot be half-copied into a state that loads but is wrong.
//
// Signum's counterpart is a TensorFlow SavedModel directory; its `PredictorDirectory` layout is kept, so
// the file sits where a Signum deployment's model did.

/** The single file a predictor's model is stored as, inside its directory. */
export const MODEL_FILE_NAME = "model.altea.json";

interface StoredModel {
    /** The format's own version, so a future change can be detected rather than mis-read. */
    formatVersion: 1;
    modelTopology: unknown;
    weightSpecs: unknown;
    /** The concatenated weight bytes, base64. */
    weightDataBase64: string;
    format?: string;
    generatedBy?: string;
    convertedBy?: string;
}

/**
 * An IOHandler that reads and writes {@link MODEL_FILE_NAME} in `directory`.
 *
 * Pass it straight to `model.save(...)` / `tf.loadLayersModel(...)` — tfjs accepts a handler object
 * wherever it accepts a URL string.
 */
export function fileModelStore(directory: string): tfc.io.IOHandler {
    const path = join(directory, MODEL_FILE_NAME);

    return {
        async save(artifacts: tfc.io.ModelArtifacts): Promise<tfc.io.SaveResult> {
            const weights = artifacts.weightData as ArrayBuffer | undefined;
            const stored: StoredModel = {
                formatVersion: 1,
                modelTopology: artifacts.modelTopology,
                weightSpecs: artifacts.weightSpecs,
                weightDataBase64: weights == null ? "" : Buffer.from(weights).toString("base64"),
                format: artifacts.format,
                generatedBy: artifacts.generatedBy,
                convertedBy: artifacts.convertedBy ?? undefined,
            };

            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, JSON.stringify(stored), "utf8");

            return {
                modelArtifactsInfo: {
                    dateSaved: new Date(),
                    modelTopologyType: "JSON",
                    modelTopologyBytes: JSON.stringify(artifacts.modelTopology ?? {}).length,
                    weightSpecsBytes: JSON.stringify(artifacts.weightSpecs ?? []).length,
                    weightDataBytes: weights?.byteLength ?? 0,
                },
            };
        },

        async load(): Promise<tfc.io.ModelArtifacts> {
            if (!existsSync(path))
                throw new Error(`No saved model at '${path}' — the predictor is not trained, or its files were removed`);

            const stored = JSON.parse(readFileSync(path, "utf8")) as StoredModel;
            if (stored.formatVersion !== 1)
                throw new Error(`Unsupported model format version ${stored.formatVersion} in '${path}'`);

            const bytes = Buffer.from(stored.weightDataBase64, "base64");
            // A fresh ArrayBuffer: a Buffer's own may be a VIEW into a larger pooled allocation, and
            // handing that to tfjs would read whatever else happens to be in the pool.
            const weightData = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

            return {
                modelTopology: stored.modelTopology as tfc.io.ModelArtifacts["modelTopology"],
                weightSpecs: stored.weightSpecs as tfc.io.ModelArtifacts["weightSpecs"],
                weightData,
                format: stored.format,
                generatedBy: stored.generatedBy,
                convertedBy: stored.convertedBy ?? null,
            };
        },
    };
}

/** Whether a directory holds a saved model. */
export function hasSavedModel(directory: string): boolean {
    return existsSync(join(directory, MODEL_FILE_NAME));
}
