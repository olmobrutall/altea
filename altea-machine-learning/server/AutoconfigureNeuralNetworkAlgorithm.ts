import "@altea/altea/server"; // installs Entity.save()/delete()
import { retrieve } from "@altea/altea/server/Database";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { toInt } from "@altea/altea/data/basics";
import { SafeConsole, Color } from "@altea/altea/server/safeConsole";
import { PredictorEntity, PredictorState } from "../data/Predictor";
import {
    AutoconfigureNeuralNetworkEntity, NeuralNetworkActivation, NeuralNetworkInitializer,
    NeuralNetworkSettingsEntity, NeuralNetworkSettingsEntity_HiddenLayer, TensorFlowOptimizer,
} from "../data/NeuralNetworkSettings";
import { PredictorLogic } from "./PredictorLogic";

// Port of Signum.MachineLearning's AutoconfigureNeuralNetworkAlgorithm.cs — a GENETIC SEARCH over the
// network's own settings.
//
// The idea: the settings that make a good model (how many layers, how wide, which activation, what
// learning rate) are not derivable from the data, and a human tuning them one at a time is slow. So train
// a POPULATION of clones with randomly mutated settings, keep the ones that scored best, breed them, and
// repeat. Each individual is a real predictor training end to end, which is why one run is a background
// PROCESS with a progress bar rather than a request.
//
// The fitness is the VALIDATION loss, not the training loss — that distinction is the whole reason the
// search works. Optimising training loss selects for models that memorised their examples; optimising
// validation loss selects for models that generalise.
//
// altea divergences, documented inline:
//  - `Random` / `r.NextDouble()` become a seeded PRNG when `conf.seed` is set, so a search is
//    reproducible; Node has none built in and `Math.random` cannot be seeded.
//  - each individual's training is AWAITED here (Signum's is too, inside the process algorithm), but the
//    training itself is the async run PredictorLogic starts — so this awaits its promise.
//  - two Signum BUGS are fixed rather than mirrored; see `mutate`.

export namespace AutoconfigureNeuralNetworkAlgorithm {

    /** The process algorithm body. `report` is how the process's progress bar is driven. */
    export async function run(
        conf: AutoconfigureNeuralNetworkEntity,
        report: (message: string, progress: number) => void,
        signal: AbortSignal,
    ): Promise<PredictorEntity | null> {
        const initial = await ExecutionMode.global(() => retrieve(PredictorEntity, conf.initialPredictor.id));
        const rand = conf.seed == null ? Math.random : mulberry32(conf.seed as number);

        const mutationProbability = conf.initialMutationProbability;
        const generations = conf.generations as number;
        const populationSize = conf.population as number;
        const total = populationSize * (generations + 1);
        let trained = 0;

        const trainOne = async (p: PredictorEntity, generation: number): Promise<number> => {
            signal.throwIfAborted?.();
            if (signal.aborted)
                throw new Error("Autoconfigure cancelled");

            trained++;
            report(`Generation ${generation}: training ${trained} of ${total}`, trained / total);
            return await trainAndScore(p);
        };

        // Generation 0: clones of the initial predictor, each mutated once.
        let population = await Promise.all(
            range(populationSize).map(async () => {
                const child = clone(initial);
                mutate(child, conf, mutationProbability, rand);
                return child;
            }));

        let evaluated = await evaluatePopulation(population, 0, trainOne);

        for (let gen = 1; gen <= generations; gen++) {
            population = crossOverPopulation(evaluated, initial, conf, rand);
            population.forEach(p => mutate(p, conf, mutationProbability, rand));
            evaluated = await evaluatePopulation(population, gen, trainOne);
        }

        // The winner: the lowest validation loss across the final generation.
        const best = [...evaluated.entries()].sort((a, b) => a[1] - b[1])[0];
        if (best == null)
            return null;

        SafeConsole.writeLineColor(Color.green,
            `[machine-learning] autoconfigure best validation loss: ${best[1].toFixed(5)}`);
        return best[0];
    }

    async function evaluatePopulation(
        population: PredictorEntity[], generation: number,
        trainOne: (p: PredictorEntity, generation: number) => Promise<number>,
    ): Promise<Map<PredictorEntity, number>> {
        const result = new Map<PredictorEntity, number>();
        // SEQUENTIALLY: each training saturates the backend, so running the population in parallel would
        // not be faster and would multiply the peak memory by the population size.
        for (const p of population)
            result.set(p, await trainOne(p, generation));
        return result;
    }

    /** Train one individual and score it by its VALIDATION loss (see the module header). */
    async function trainAndScore(predictor: PredictorEntity): Promise<number> {
        await ExecutionMode.global(() => Transaction.forceNew(async () => { await predictor.save(); }));

        PredictorLogic.startTraining(predictor);
        await PredictorLogic.trainingPromise(predictor);

        if (predictor.state !== PredictorState.Trained)
            return Number.POSITIVE_INFINITY; // a failed individual is simply the worst

        return predictor.resultValidation?.loss
            ?? predictor.resultTraining?.loss
            ?? Number.POSITIVE_INFINITY;
    }

    /**
     * Roulette-wheel selection weighted by `1 / (loss + 0.01)`.
     *
     * The inversion is what turns "lower is better" into a selection weight, and the `+ 0.01` is what
     * keeps a perfect individual (loss 0) from being an infinite weight that crowds out everything else.
     */
    export function crossOverPopulation(
        evaluated: Map<PredictorEntity, number>,
        initial: PredictorEntity,
        conf: AutoconfigureNeuralNetworkEntity,
        rand: () => number,
    ): PredictorEntity[] {
        const weights = [...evaluated.entries()]
            // An individual that failed to train has infinite loss ⇒ zero weight; it must not be picked.
            .map(([p, loss]) => [p, Number.isFinite(loss) ? 1 / (loss + 0.01) : 0] as const)
            .filter(([, w]) => w > 0);

        const total = weights.reduce((a, [, w]) => a + w, 0);

        const selectRandomly = (): PredictorEntity => {
            if (weights.length === 0)
                return initial;
            const point = rand() * total;
            let acc = 0;
            for (const [p, w] of weights) {
                acc += w;
                if (point < acc)
                    return p;
            }
            return weights[weights.length - 1]![0];
        };

        return range(conf.population as number)
            .map(() => crossOver(clone(initial), selectRandomly(), selectRandomly(), rand));
    }

    /** Each setting comes from one parent or the other. */
    export function crossOver(
        child: PredictorEntity, father: PredictorEntity, mother: PredictorEntity, rand: () => number,
    ): PredictorEntity {
        const c = settingsOf(child);
        const f = settingsOf(father);
        const m = settingsOf(mother);

        const pick = <T>(a: T, b: T): T => rand() < 0.5 ? a : b;

        c.optimizer = pick(f.optimizer, m.optimizer);
        c.learningRate = pick(f.learningRate, m.learningRate);
        c.learningEpsilon = pick(f.learningEpsilon, m.learningEpsilon);
        c.outputActivation = pick(f.outputActivation, m.outputActivation);
        c.outputInitializer = pick(f.outputInitializer, m.outputInitializer);

        // The hidden layers come from ONE parent as a whole rather than being interleaved: a layer's
        // width only means something in the context of the layers around it, so mixing two architectures
        // layer by layer mostly produces individuals that are worse than either parent.
        const source = rand() < 0.5 ? f : m;
        c.hiddenLayers = source.hiddenLayers.map(hl => hl.clone());

        return child;
    }

    /**
     * Perturb the settings the configuration says to explore.
     *
     * TWO Signum bugs are fixed rather than mirrored, both in the layer-count line:
     *   `Math.Min(0, Math.Max(count ± 1, conf.MaxLayers))`
     *  1. the arguments are the wrong way round — `Min(0, …)` can only ever be ≤ 0, so `shouldHidden` is
     *     0 or negative and the "add a layer" branch is unreachable: the search can only ever REMOVE
     *     layers, never add one, which silently defeats `ExploreHiddenLayers`;
     *  2. `Max(x, MaxLayers)` raises x to the maximum rather than capping it.
     * The intent is plainly "step one layer up or down, clamped to 0..MaxLayers", which is what this does.
     */
    export function mutate(
        predictor: PredictorEntity,
        conf: AutoconfigureNeuralNetworkEntity,
        mutationProbability: number,
        rand: () => number,
    ): void {
        const nns = settingsOf(predictor);
        const hits = (): boolean => rand() < mutationProbability;
        const pickOne = <T>(values: T[]): T => values[Math.floor(rand() * values.length)]!;

        const activations = enumValues(NeuralNetworkActivation);
        const initializers = enumValues(NeuralNetworkInitializer);

        if (conf.exploreLearner && hits())
            nns.optimizer = pickOne(enumValues(TensorFlowOptimizer));

        if (conf.exploreLearningValues && hits()) {
            // A MULTIPLICATIVE step, because a learning rate spans orders of magnitude: adding a constant
            // would be a huge change at 1e-4 and a rounding error at 1.
            const ratio = 1.1 + rand() * 0.9;
            nns.learningRate = rand() < 0.5 ? nns.learningRate / ratio : nns.learningRate * ratio;
        }

        if (conf.exploreHiddenLayers) {
            if (hits()) {
                const step = rand() < 0.5 ? 1 : -1;
                // See the doc comment: clamped to 0..maxLayers, which is what Signum meant to write.
                const target = Math.max(0, Math.min(nns.hiddenLayers.length + step, conf.maxLayers as number));

                if (target > nns.hiddenLayers.length) {
                    nns.hiddenLayers.push(NeuralNetworkSettingsEntity_HiddenLayer.create({
                        rowOrder: toInt(nns.hiddenLayers.length),
                        size: toInt(randomBetween(rand, conf.minNeuronsPerLayer as number, conf.maxNeuronsPerLayer as number)),
                        activation: pickOne(activations),
                        initializer: pickOne(initializers),
                    }));
                } else if (target < nns.hiddenLayers.length) {
                    nns.hiddenLayers.splice(Math.floor(rand() * nns.hiddenLayers.length), 1);
                    // Re-number, since @rowOrder is positional.
                    nns.hiddenLayers.forEach((hl, i) => hl.rowOrder = toInt(i));
                }
            }

            for (const hl of nns.hiddenLayers) {
                if (hits()) {
                    // Signum averages the current size with a fresh random one, which is a SMALLER step
                    // than replacing it — a mutation that jumps the whole range explores badly.
                    const fresh = randomBetween(rand, conf.minNeuronsPerLayer as number, conf.maxNeuronsPerLayer as number);
                    hl.size = toInt(Math.round((fresh + (hl.size as number)) / 2));
                }
                if (hits())
                    hl.activation = pickOne(activations);
                if (hits())
                    hl.initializer = pickOne(initializers);
            }
        }

        if (conf.exploreOutputLayer) {
            if (hits())
                nns.outputActivation = pickOne(activations);
            if (hits())
                nns.outputInitializer = pickOne(initializers);
        }
    }

    // ---- helpers ---------------------------------------------------------------------------------------

    function settingsOf(predictor: PredictorEntity): NeuralNetworkSettingsEntity {
        const nns = predictor.algorithmSettings as NeuralNetworkSettingsEntity;
        if (nns?.hiddenLayers == null)
            throw new Error(`Predictor '${predictor.name}' has no NeuralNetworkSettings to autoconfigure`);
        return nns;
    }

    function clone(initial: PredictorEntity): PredictorEntity {
        return PredictorLogic.clonePredictor(initial);
    }

    /** The numeric members of an altea enum object (its values, not its reverse-mapping names). */
    function enumValues<T extends object>(enumObject: T): T[keyof T][] {
        return Object.values(enumObject).filter(v => typeof v === "number") as T[keyof T][];
    }

    function randomBetween(rand: () => number, min: number, max: number): number {
        return min + Math.floor(rand() * Math.max(1, max - min + 1));
    }

    function range(count: number): number[] {
        return Array.from({ length: Math.max(0, count) }, (_, i) => i);
    }

    /** The same seeded PRNG the query pipeline uses; see its comment on why Node needs one. */
    function mulberry32(seed: number): () => number {
        let a = seed >>> 0;
        return () => {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
}
