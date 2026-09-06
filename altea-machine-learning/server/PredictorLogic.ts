import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { type FluentStateMachine } from "@altea/altea/server/fluentOperations";
import { table } from "@altea/altea/server/table";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { UserHolder } from "@altea/altea/server/userHolder";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { Saver } from "@altea/altea/server/saver";
import { SafeConsole, Color } from "@altea/altea/server/safeConsole";
import { toInt } from "@altea/altea/data/basics";
import type { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { FileTypeLogic } from "@altea/altea-files/server/FileTypeLogic";
import { FilePathEmbeddedLogic } from "@altea/altea-files/server/FilePathEmbeddedLogic";
import type { IFileTypeAlgorithm } from "@altea/altea-files/server/FileTypeAlgorithm";
import {
    PredictorAlgorithmSymbol, PredictorCodificationEntity, PredictorEntity, PredictorEpochProgressEntity,
    PredictorFileType, PredictorMessage, PredictorOperation, PredictorPublicationSymbol,
    PredictorResultSaverSymbol, PredictorState, PredictorSubQueryEntity, PredictSimpleResultEntity,
    PredictorProcessAlgorithm,
    PredictorColumnUsage, TensorFlowPredictorAlgorithm, PredictorClassificationMetricsEmbedded,
    DefaultColumnEncodings, PredictorMainQueryEmbedded, PredictorMetricsEmbedded,
    PredictorEntity_Filter, PredictorSubQueryEntity_Filter, PredictorColumnEncodingSymbol,
} from "../data/Predictor";
import { NeuralNetworkSettingsEntity, validateOutputActivation } from "../data/NeuralNetworkSettings";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { QueryFilterBaseEntity, QueryTokenEmbedded } from "@altea/altea-user-assets/data/Queries";
import {
    PredictorTrainingContext, TrainingCancelledError, type IPredictorAlgorithm, type IPredictorResultSaver,
    type TrainingProgress,
} from "./PredictorAlgorithm";
import { PredictorLogicQuery } from "./PredictorLogicQuery";
import { PredictorCodificationLogic } from "./PredictorCodificationLogic";
import { TensorFlowNeuralNetworkPredictor } from "./tensorflow/TensorFlowNeuralNetworkPredictor";
import { PredictorSimpleSaver } from "./PredictorSimpleSaver";
import { PredictorServer } from "./PredictorServer";
import { AutoconfigureNeuralNetworkAlgorithm } from "./AutoconfigureNeuralNetworkAlgorithm";
import { ProcessLogic } from "@altea/altea-processes/server/ProcessLogic";
import { retrieve } from "@altea/altea/server/Database";
import { Decimal } from "@altea/altea/data/basics";
import { AutoconfigureNeuralNetworkEntity } from "../data/NeuralNetworkSettings";

// Port of Signum.MachineLearning's PredictorLogic.cs — the module's `start`, its registries, and the
// TRAINING orchestration.
//
// The state machine is the shape to hold on to: a predictor is Draft while it is being defined, Training
// while a run is in flight, Trained when a model is on disk, and Error when a run failed. Training is
// asynchronous and cancellable, so the run does NOT sit inside the operation's transaction — the
// operation flips the state and starts the work, and the work commits its own progress. That is why
// `trainingProgress` exists as an endpoint rather than the operation simply returning a result.
//
// altea divergences, documented inline:
//  - Signum runs each training on a `Task` it tracks in a static dictionary keyed by the predictor's id;
//    here that is a Map of AbortControllers, which is the same bookkeeping plus a cancellation handle
//    Node actually has.
//  - `OperationLogic.AllowSave` / `PermissionLogic.RegisterPermissions` / `ExceptionLogic.DeleteLogs`
//    have no counterparts (the notes the other ports carry).
//  - Signum's `PredictorMainQueryEmbedded.ParseData` is gone with QueryDescription; a token is resolved
//    where it is used (PredictorLogicQuery), so a stale one fails at TRAIN time with the predictor named.
//  - the metrics that Signum computes in `PreSaving` (the classification miss rate) are computed by the
//    training run, because altea has no entity-level PreSaving hook — see `finishTraining`.

export namespace PredictorLogic {

    /** Signum's `Algorithms` — the registry of algorithms, keyed by symbol key. */
    export const algorithms = new Map<string, IPredictorAlgorithm>();

    /** Signum's `ResultSavers`. */
    export const resultSavers = new Map<string, IPredictorResultSaver>();

    /** Signum's `Publications` — a publication symbol says "this trained model is the live one for X". */
    export const publications = new Map<string, Lite<Entity> | null>();

    export function registerAlgorithm(symbol: PredictorAlgorithmSymbol, algorithm: IPredictorAlgorithm): void {
        algorithms.set(symbol.key, algorithm);
    }

    export function registerResultSaver(symbol: PredictorResultSaverSymbol, saver: IPredictorResultSaver): void {
        resultSavers.set(symbol.key, saver);
    }

    export function registerPublication(symbol: PredictorPublicationSymbol): void {
        publications.set(symbol.key, null);
    }

    export function algorithmOf(predictor: PredictorEntity): IPredictorAlgorithm {
        const a = algorithms.get(predictor.algorithm.key);
        if (a == null)
            throw new Error(`No algorithm registered for '${predictor.algorithm.key}'`);
        return a;
    }

    let started = false;
    export function isStarted(): boolean { return started; }

    export function start(sb: SchemaBuilder, options?: { predictorFile?: IFileTypeAlgorithm }): void {
        if (sb.alreadyDefined(start))
            return;
        started = true;

        // Signum's `PredictorLogic.IgnorePinned`, which Southwind calls from OverrideAttributes and
        // Signum then ASSERTS was called (its two `AssertIgnored` lines).
        //
        // A PINNED filter is a SearchControl affordance — "show this filter in the header, let the user
        // change it" — and a predictor's filters are not a search: they define the training population,
        // which is fixed once and read by a background process. So the seven pinned columns are dead
        // weight on both filter tables, which is why Signum drops them.
        //
        // Here it is done in `start` rather than left to the app: altea's filter rows share
        // QueryFilterBaseEntity, so the routes exist unless the MODULE says otherwise, and an app that
        // forgot the call would silently get seven columns Signum's schema does not have. It must precede
        // the includes below — the same ordering rule Signum has.
        ignorePinned(sb);

        FilePathEmbeddedLogic.start(sb);
        FileTypeLogic.start(sb);
        if (options?.predictorFile != undefined)
            FileTypeLogic.register(PredictorFileType.PredictorFile, options.predictorFile);

        sb.include(PredictorEntity)
            .withStateMachine(p => p.state, registerPredictorOperations)
            .withQuery();

        // A sub-query is a @part row of the predictor, so generateField already includes its TABLE —
        // but an auto-included part gets no QUERY, and Signum gives this one a search page of its own
        // (`sb.Include<PredictorSubQueryEntity>().WithQuery(…)`). The include is idempotent, so this
        // adds the query and nothing else.
        sb.include(PredictorSubQueryEntity).withQuery();

        // The Autoconfigure definition needs an EXPLICIT include: it is only ever reached through
        // `ProcessEntity.data`, which is @implementedByAll and therefore references no type in
        // particular — so nothing would bring its table into the schema.
        sb.include(AutoconfigureNeuralNetworkEntity).withQuery();

        // The derived rows. Each is written by the engine and read by the UI, never edited.
        sb.include(PredictorCodificationEntity).withQuery();
        sb.include(PredictorEpochProgressEntity).withQuery();
        sb.include(PredictSimpleResultEntity).withQuery();

        // The one algorithm the module ships, and the six encodings behind it.
        registerAlgorithm(TensorFlowPredictorAlgorithm.NeuralNetworkGraph, TensorFlowNeuralNetworkPredictor.algorithm);

        // The two result savers (Signum registers these in its own Start too).
        PredictorSimpleSaver.register(registerResultSaver);

        // The Autoconfigure genetic search as a background PROCESS: one run trains a whole population, so
        // it belongs where a user can watch its progress and cancel it (Signum registers the same
        // algorithm). The process's own AbortSignal is what a cancel reaches the search through.
        ProcessLogic.registerAction(PredictorProcessAlgorithm.AutoconfigureNeuralNetwork, async executing => {
            const conf = await retrieve(AutoconfigureNeuralNetworkEntity,
                (executing.data as Lite<AutoconfigureNeuralNetworkEntity>).id);

            const best = await AutoconfigureNeuralNetworkAlgorithm.run(conf,
                (message, progress) => { void executing.progressChangedDecimal(new Decimal(progress).toDecimalPlaces(3), message); },
                executing.signal);

            if (best != null)
                SafeConsole.writeLineColor(Color.green,
                    "[machine-learning] autoconfigure produced predictor '" + best.name + "'");
        });

        if (sb.webBuilder)
            PredictorServer.start(sb.webBuilder);

        // The four symbol tables, seeded and synchronized — Signum's four `SymbolLogic<X>.Start` calls.
        //
        // These are LAST on purpose: altea's default `getSymbols` is "every symbol of this type that has
        // been DECLARED", and a declaration happens when the containing namespace object is first
        // touched. `registerAlgorithm` / `registerResultSaver` above are what touch the algorithm and
        // saver symbols, so a synchronizer registered before them would seed an empty table. The
        // ENCODINGS have no such registrar (they are named by an algorithm's
        // `getRegisteredEncodingSymbols`, which is data, not a registration), so they are touched here —
        // Signum reaches them through `Algorithms.Values.SelectMany(...)`, which amounts to the same.
        void DefaultColumnEncodings.None;
        void DefaultColumnEncodings.OneHot;
        void DefaultColumnEncodings.NormalizeZScore;
        void DefaultColumnEncodings.NormalizeMinMax;
        void DefaultColumnEncodings.NormalizeLog;
        void DefaultColumnEncodings.SplitWords;

        SymbolLogic.start(sb, PredictorAlgorithmSymbol);
        SymbolLogic.start(sb, PredictorColumnEncodingSymbol);
        SymbolLogic.start(sb, PredictorResultSaverSymbol);
        SymbolLogic.start(sb, PredictorPublicationSymbol);

        // Each symbol table also needs a QUERY, because the designer picks from it: an EntityCombo over
        // `algorithm` / `encoding` / `resultSaver` loads its options by RUNNING the type's query, so
        // without these four the three combos of a new predictor answer 500 and the form is unusable.
        // Signum's `SymbolLogic<T>.Start` registers the query itself (`sb.Include<T>().WithQuery(...)`);
        // altea's does not, so each module declares it — the shape nine other packages already use.
        sb.include(PredictorAlgorithmSymbol).withQuery();
        sb.include(PredictorColumnEncodingSymbol).withQuery();
        sb.include(PredictorResultSaverSymbol).withQuery();
        sb.include(PredictorPublicationSymbol).withQuery();
    }

    /** Signum's `IgnorePinned(sb)` — see the call in `start` for why. */
    export function ignorePinned(sb: SchemaBuilder): void {
        sb.settings.ignoreFieldRoute(PredictorEntity_Filter, "pinned");
        sb.settings.ignoreFieldRoute(PredictorSubQueryEntity_Filter, "pinned");
    }

    // ---- the runs in flight ----------------------------------------------------------------------------

    interface TrainingRun {
        ctx: PredictorTrainingContext;
        controller: AbortController;
        /** The promise, so a second Train on the same predictor can be refused rather than racing. */
        promise: Promise<void>;
    }

    /** Signum's `Trainings` static dictionary, keyed by the predictor's id. */
    const trainings = new Map<string, TrainingRun>();

    export function isTraining(predictor: PredictorEntity): boolean {
        return trainings.has(String(predictor.id));
    }

    /** Signum's `TrainingProgress(predictor)` — what the client polls while a run is in flight. */
    export function trainingProgress(predictor: PredictorEntity): TrainingProgress {
        const run = trainings.get(String(predictor.id));
        if (run == null)
            return { message: null, progress: null, running: false, state: predictor.state, epochProgresses: null };

        return {
            message: run.ctx.message,
            progress: run.ctx.progress,
            running: true,
            state: PredictorState.Training,
            epochProgresses: run.ctx.epochProgresses.map(e => e.toRow()),
        };
    }

    /** Signum's `CancelTraining` / `StopTraining`. */
    export function cancelTraining(predictor: PredictorEntity): void {
        trainings.get(String(predictor.id))?.controller.abort();
    }

    export function stopTraining(predictor: PredictorEntity): void {
        const run = trainings.get(String(predictor.id));
        if (run != null)
            run.ctx.stopTraining = true;
    }

    // ---- training --------------------------------------------------------------------------------------

    /**
     * Signum's `Train(predictor)` — start a run and return immediately.
     *
     * The run is deliberately NOT awaited by the operation: a training takes minutes, and holding the
     * operation's transaction open for it would hold locks on the predictor row the whole time (and time
     * the request out). So the operation flips the state to Training and commits; the run then commits its
     * own progress and its own final state. `trainingProgress` is how a caller follows it.
     */
    export function startTraining(predictor: PredictorEntity): void {
        const key = String(predictor.id);
        if (trainings.has(key))
            throw new Error(PredictorMessage._0IsAlreadyBeingTrained.niceToString(predictor.name ?? key));

        const controller = new AbortController();
        const ctx = new PredictorTrainingContext(predictor, controller.signal, algorithmOf(predictor));
        const promise = runTraining(ctx).finally(() => { trainings.delete(key); });

        trainings.set(key, { ctx, controller, promise });
    }

    /** Await a run — for a test or a synchronous caller (the Autoconfigure search). */
    export function trainingPromise(predictor: PredictorEntity): Promise<void> | undefined {
        return trainings.get(String(predictor.id))?.promise;
    }

    /** Signum's training body: retrieve, codify, fit, score, save. */
    export async function runTraining(ctx: PredictorTrainingContext): Promise<void> {
        const predictor = ctx.predictor;
        const algorithm = algorithmOf(predictor);

        try {
            ctx.reportProgress(PredictorMessage.Preprocessing.niceToString());

            // Every run starts from a clean slate: the previous run's derived rows describe a MODEL that
            // is about to be replaced (see PredictorCodificationLogic's header).
            await ExecutionMode.global(async () => {
                await PredictorCodificationLogic.deleteCodifications(predictor);
                const id = predictor.id;
                await table(PredictorEpochProgressEntity).filter(e => e.predictor.id == id).executeDelete();
                await table(PredictSimpleResultEntity).filter(e => e.predictor.id == id).executeDelete();
            });

            await PredictorLogicQuery.retrieveData(ctx, algorithm);
            ctx.assertNotCancelled();

            if (ctx.inputCodifications.length === 0)
                throw new Error(PredictorMessage.NoInputColumn.niceToString());
            if (ctx.outputCodifications.length === 0)
                throw new Error(PredictorMessage.NoOutputColumn.niceToString());

            await PredictorCodificationLogic.saveCodifications(predictor, ctx.codifications);

            await algorithm.train(ctx);
            ctx.assertNotCancelled();

            await finishTraining(ctx);
        } catch (e) {
            if (e instanceof TrainingCancelledError) {
                // A cancelled run leaves the predictor back in Draft: nothing was learned, so calling it
                // Trained would be a lie and calling it Error would blame the user's own cancel.
                await setState(predictor, PredictorState.Draft, null);
                return;
            }

            const exception = await ExceptionLogic.logException(e,
                ex => { ex.controllerName = "PredictorLogic.Train"; });
            await setState(predictor, PredictorState.Error, exception.toLite());
            SafeConsole.writeLineColor(Color.red,
                `[machine-learning] training '${predictor.name}' failed: ${(e as Error).message}`);
        }
    }

    /** Score the fitted model, store the metrics and the progress rows, and flip to Trained. */
    async function finishTraining(ctx: PredictorTrainingContext): Promise<void> {
        const predictor = ctx.predictor;
        const model = ctx.trainedModel;

        ctx.reportProgress(PredictorMessage.Saving.niceToString());

        if (model != null) {
            const inputSize = ctx.inputCodifications.length;
            const outputSize = ctx.outputCodifications.length;
            const training = await TensorFlowNeuralNetworkPredictor.evaluate(
                model as never, ctx.training, inputSize, outputSize);
            const validation = await TensorFlowNeuralNetworkPredictor.evaluate(
                model as never, ctx.validation, inputSize, outputSize);

            predictor.resultTraining = metrics(training);
            predictor.resultValidation = metrics(validation);
        }

        // The epoch rows, in one save (a long run records many).
        if (ctx.epochProgresses.length > 0)
            await ExecutionMode.global(() => Transaction.forceNew(async () => {
                await Saver.save(ctx.epochProgresses.map(e => e.toEntity(predictor)) as never[]);
            }));

        // The result saver writes the per-row predictions, when the predictor asks for them.
        if (predictor.resultSaver != null) {
            const saver = resultSavers.get(predictor.resultSaver.key);
            if (saver == null)
                throw new Error(`No result saver registered for '${predictor.resultSaver.key}'`);
            ctx.reportProgress("Saving predictions");
            await saver.savePredictions(ctx);
        }

        await setState(predictor, PredictorState.Trained, null);
        ctx.reportProgress(PredictorMessage.Done.niceToString(), 1);
    }

    function metrics(m: { loss: number | null; accuracy: number | null }): PredictorMetricsEmbedded {
        return PredictorMetricsEmbedded.create({ loss: m.loss, accuracy: m.accuracy });
    }

    async function setState(
        predictor: PredictorEntity, state: PredictorState, exception: Lite<Entity> | null,
    ): Promise<void> {
        predictor.state = state;
        predictor.trainingException = exception as never;
        await ExecutionMode.global(() => Transaction.forceNew(async () => { await predictor.save(); }));
    }

    // ---- the state machine -----------------------------------------------------------------------------

    /** Port of Signum's `PredictorGraph`. */
    function registerPredictorOperations(sm: FluentStateMachine<PredictorEntity, PredictorState>): void {
        sm.withSave(PredictorOperation.Save, {
            fromStates: [PredictorState.Draft],
            toStates: [PredictorState.Draft],
            canBeNew: true,
            canBeModified: true,
            execute: p => { assertValid(p); },
        });

        sm.withExecute(PredictorOperation.Train, {
            fromStates: [PredictorState.Draft, PredictorState.Trained, PredictorState.Error],
            toStates: [PredictorState.Training],
            execute: p => {
                assertValid(p);
                p.state = PredictorState.Training;
                p.trainingException = null;
                // Started AFTER this transaction commits, so the run sees the Training state and does not
                // contend with the operation's own write.
                Transaction.postRealCommit(() => { startTraining(p); });
            },
        });

        sm.withExecute(PredictorOperation.CancelTraining, {
            fromStates: [PredictorState.Training],
            toStates: [PredictorState.Draft],
            execute: p => { cancelTraining(p); },
        });

        sm.withExecute(PredictorOperation.StopTraining, {
            fromStates: [PredictorState.Training],
            toStates: [PredictorState.Training],
            execute: p => { stopTraining(p); },
        });

        sm.withExecute(PredictorOperation.Untrain, {
            fromStates: [PredictorState.Trained, PredictorState.Error],
            toStates: [PredictorState.Draft],
            execute: async p => {
                TensorFlowNeuralNetworkPredictor.deleteModel(p);
                await PredictorCodificationLogic.deleteCodifications(p);
                const id = p.id;
                await ExecutionMode.global(async () => {
                    await table(PredictorEpochProgressEntity).filter(e => e.predictor.id == id).executeDelete();
                    await table(PredictSimpleResultEntity).filter(e => e.predictor.id == id).executeDelete();
                });
                p.state = PredictorState.Draft;
                p.resultTraining = null;
                p.resultValidation = null;
                p.classificationTraining = null;
                p.classificationValidation = null;
                p.regressionTraining = null;
                p.regressionValidation = null;
                p.trainingException = null;
            },
        });

        sm.withExecute(PredictorOperation.Publish, {
            fromStates: [PredictorState.Trained],
            toStates: [PredictorState.Trained],
            execute: p => {
                if (p.publication == null)
                    throw new Error("The predictor has no Publication to publish to");
                if (!publications.has(p.publication.key))
                    throw new Error(`No publication registered for '${p.publication.key}'`);
                // Signum unpublishes every OTHER predictor of the same publication — a publication names
                // the ONE live model for a purpose, so two would make "the current model" ambiguous.
                Transaction.postRealCommit(() => { void unpublishOthers(p); });
            },
        });

        sm.parent.withConstructFrom(PredictorEntity, PredictorOperation.Clone, {
            construct: p => clonePredictor(p),
        });
    }

    async function unpublishOthers(published: PredictorEntity): Promise<void> {
        const key = published.publication!.key;
        const id = published.id;
        await ExecutionMode.global(async () => {
            const others = await table(PredictorEntity)
                .filter(p => p.publication!.key == key && p.id != id).toArray() as PredictorEntity[];
            for (const other of others) {
                other.publication = null;
                await Transaction.forceNew(async () => { await other.save(); });
            }
        });
    }

    /** Signum's `Clone` — a deep copy in Draft, sharing nothing with the original. */
    export function clonePredictor(source: PredictorEntity): PredictorEntity {
        return PredictorEntity.create({
            name: (source.name ?? "") + " (clone)",
            settings: source.settings.clone(),
            algorithm: source.algorithm,
            resultSaver: source.resultSaver,
            publication: null, // a clone must not steal the original's publication
            algorithmSettings: source.algorithmSettings.cloneSettings(),
            state: PredictorState.Draft,
            mainQuery: PredictorMainQueryEmbedded.create({
                query: source.mainQuery.query,
                groupResults: source.mainQuery.groupResults,
            }),
            filters: source.filters.map(f => PredictorEntity_Filter.create(filterFields(f))),
            columns: source.columns.map(c => c.clone()),
            subQueries: source.subQueries.map(sq => cloneSubQuery(sq)),
            files: [],
        });
    }

    /**
     * The fields of a filter row, for a clone. The caller passes them to its OWN row type's `create`, so
     * the result is a genuinely new entity (its own snapshot, no id, its @backReference filled by the save
     * cascade) — a structural `Object.assign` copy would carry the source's id and save as an UPDATE of it.
     */
    function filterFields(filter: QueryFilterBaseEntity) {
        return {
            token: filter.token == null ? null
                : QueryTokenEmbedded.create({ tokenString: filter.token.tokenString }),
            isGroup: filter.isGroup,
            groupOperation: filter.groupOperation,
            operation: filter.operation,
            valueString: filter.valueString,
            indentation: filter.indentation,
            pinned: filter.pinned,
            dashboardBehaviour: filter.dashboardBehaviour,
        };
    }

    function cloneSubQuery(sq: PredictorSubQueryEntity): PredictorSubQueryEntity {
        return PredictorSubQueryEntity.create({
            name: sq.name,
            query: sq.query,
            filters: sq.filters.map(f => PredictorSubQueryEntity_Filter.create(filterFields(f))),
            columns: sq.columns.map(c => c.clone()),
        });
    }

    /**
     * Signum's `AssertValid` — the rules a predictor must satisfy before it can train, checked at SAVE
     * time so a broken definition is refused where the author can see why.
     */
    export function assertValid(predictor: PredictorEntity): void {
        const algorithm = algorithmOf(predictor);

        if (!predictor.columns.some(c => c.usage === PredictorColumnUsage.Input))
            throw new Error(PredictorMessage.NoInputColumn.niceToString());
        if (!predictor.columns.some(c => c.usage === PredictorColumnUsage.Output))
            throw new Error(PredictorMessage.NoOutputColumn.niceToString());

        // Signum's output-activation rule, which its entity checks through [BindParent] — see
        // data/NeuralNetworkSettings' validateOutputActivation on why it is called from here.
        const nn = predictor.algorithmSettings as unknown as NeuralNetworkSettingsEntity;
        if (nn?.outputActivation != null) {
            const error = validateOutputActivation(nn, predictor, DefaultColumnEncodings.NormalizeZScore.key);
            if (error != null)
                throw new Error(error);
        }

        // Each column's encoding must suit its own token — the algorithm decides.
        const mainQueryName = PredictorLogicQuery.queryNameOf(predictor);
        const options = PredictorLogicQuery.mainOptions(predictor);
        for (const col of predictor.columns) {
            const token = QueryLogic.getToken(mainQueryName, col.token.tokenString, options);
            const error = algorithm.validateEncodingProperty(predictor, null, col.encoding, col.usage, token);
            if (error != null)
                throw new Error(error);
        }

        if (predictor.resultSaver != null) {
            const saver = resultSavers.get(predictor.resultSaver.key);
            if (saver == null)
                throw new Error(`No result saver registered for '${predictor.resultSaver.key}'`);
            saver.assertValid(predictor);
        }
    }
}
