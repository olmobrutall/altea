import "@altea/altea/server"; // installs save()/toLite()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import "@altea/altea/server/operationFluentInclude"; // FluentInclude.withSave / withDelete
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { FluentInclude } from "@altea/altea/server/schema/fluentInclude";
import { table } from "@altea/altea/server/table";
import { graph } from "@altea/altea/server/graphBuilder";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { UserHolder } from "@altea/altea/server/userHolder";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { withQuoted } from "@altea/altea/data/decorators";
import type { IQuery } from "@altea/altea/data/iquery";
import { Entity, type Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { Clock } from "@altea/altea/data/utils/clock";
import { Temporal } from "@altea/altea/data/basics";
import { UserEntity } from "@altea/altea-auth/data/User";
import type { TypeConditionSymbol } from "@altea/altea-auth/data/Rules";
import { TypeConditionLogic } from "@altea/altea-auth/server/TypeConditionLogic";
import {
    AlertEntity, AlertOperation, AlertState, AlertTypeSymbol, AlertMessage, type IAlertTarget,
} from "../data/Alert";
import { AlertsServer } from "./AlertsServer.server";

// Port of Signum.Alerts' AlertLogic.cs — the module starter, the alert-type registry, and the helpers an
// application calls to raise / attend / delete alerts.
//
// altea divergences beyond the entity ones (see data/Alert.ts):
//
//  - **`SystemAlertTypes` is the WHOLE registry.** Signum's SemiSymbolLogic also loads user-created rows;
//    here every alert type is code-declared, so `SymbolLogic.start(sb, AlertTypeSymbol, …)` over the
//    registered keys is the whole story.
//  - **no `PreDeleteSqlSync` hooks.** Signum offers, during a synchronization, to delete the alerts that
//    point at a TypeEntity or an AlertTypeSymbol being removed, via `Administrator.DeleteWhereScript`.
//    altea has no such script builder; a removed type's alerts are left for the app to clean, and the
//    synchronizer's FK checks surface them. Deferred, not refused.
//  - **`UnsafeInsertAlerts` is not ported**: altea has no set-based INSERT-from-query (Signum's UnsafeInsert;
//    altea has executeUpdate / executeDelete but no executeInsert-from-query), so
//    a bulk raise is `createAlert` per row inside one transaction.
//  - **`CreateAlert` does not lift authorization.** Signum wraps the save in
//    `TypeAuthLogic.OverrideTypeAllowed<AlertEntity>(Write)` + `OperationLogic.AllowSave<AlertEntity>()`
//    because an alert is raised BY the system ON BEHALF of a user who may not be allowed to write alerts.
//    altea's counterpart is `ExecutionMode.global`, which is what every other module uses to step outside
//    the current user's rules for a system write.
export namespace AlertLogic {

    /** Signum's `AlertLogic.Started` — an app that never started the module gets nulls, not exceptions. */
    export let started = false;

    /** Signum's `DefaultRecipient` — who a hand-created alert is addressed to when the user picks nobody. */
    export let defaultRecipient: () => Lite<UserEntity> | null = () => null;

    /** Signum's `SystemAlertTypes`: the declared alert types and the text each one stands for. */
    export const systemAlertTypes = new Map<AlertTypeSymbol, AlertTypeOptions>();

    export interface AlertTypeOptions {
        /** Signum's `GetText` — the body of an alert of this type when the row has no `textField`. */
        getText?: () => string;
    }

    /** Signum's `RegisterAlertType`. Call BEFORE start: the symbol table is seeded from these keys. */
    export function registerAlertType(alertType: AlertTypeSymbol, options?: AlertTypeOptions | (() => string)): void {
        if (alertType.key == null || alertType.key === "")
            throw new Error("registerAlertType: the alert type has no key (declare it with `init()`)");
        systemAlertTypes.set(alertType, typeof options === "function" ? { getText: options } : options ?? {});
    }

    /** Signum's `alertType.GetText()`. Keyed by KEY, not identity: a symbol read from the database is a
     *  different instance than the declared singleton (the lesson from the scheduler port). */
    export function getText(alertType: AlertTypeSymbol | null): string | null {
        if (alertType == null)
            return null;
        for (const [declared, options] of systemAlertTypes)
            if (declared.key === alertType.key)
                return options.getText?.() ?? null;
        return null;
    }

    /**
     * Signum's `AlertLogic.Start(sb, registerExpressionsFor)`.
     *
     * `registerExpressionsFor` are the types that get the `Alerts` / `MyActiveAlerts` sub-tokens — per
     * CONCRETE type, because altea keys an extension token on a constructor (see data/Alert.ts).
     */
    export function start(sb: SchemaBuilder, options?: { registerExpressionsFor?: Type<Entity>[] }): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(AlertEntity).withQuery();

        SymbolLogic.start(sb, AlertTypeSymbol, () => [...systemAlertTypes.keys()]);

        registerAlertGraph();

        // Signum's `Retrieved` event: the row carries the text its TYPE stands for, so a client that has no
        // access to the server registry can still render an alert with no `textField` of its own.
        sb.schema.entityEvents(AlertEntity).retrieved.push(a => {
            a.textFromAlertType = getText(a.alertType);
        });

        for (const type of options?.registerExpressionsFor ?? [])
            registerExpressions(type);

        started = true;

        if (sb.webBuilder)
            AlertsServer.start(sb.webBuilder, sb);
    }

    /**
     * Signum's two `QueryLogic.Expressions.Register(new ExtensionInfo(type, alerts, …))` calls. altea cannot
     * key an extension token on `Entity` itself (the token walk follows the concrete prototype chain), so the
     * method is stamped onto the type's prototype and registered per type — the accommodation
     * altea-workflow's `registerMainEntity` already makes.
     */
    export function registerExpressions<T extends Entity>(type: Type<T>): void {
        const proto = (type as unknown as { prototype: Record<string, unknown> }).prototype;

        proto.alerts = withQuoted(function (this: Entity): IQuery<AlertEntity> {
            return table(AlertEntity).filter(a => a.target!.is(this));
        });
        proto.myActiveAlerts = withQuoted(function (this: Entity): IQuery<AlertEntity> {
            return table(AlertEntity).filter(a =>
                a.target!.is(this)
                && a.recipient!.is(UserHolder.currentUserLite())
                && a.attendedDate == null
                && Temporal.PlainDateTime.compare(a.alertDate, Clock.now) <= 0);
        });

        QueryLogic.expressions.register(type, (e: IAlertTarget) => e.alerts!(),
            { niceName: () => AlertEntity.nicePluralName() });
        QueryLogic.expressions.register(type, (e: IAlertTarget) => e.myActiveAlerts!(),
            { niceName: () => AlertMessage.MyActiveAlerts.niceToString() });
    }

    // ---- Raising alerts ---------------------------------------------------------------------------------

    export interface CreateAlertOptions {
        text?: string | null;
        /** Resolves `{0}` / `{1}` placeholders in `text` (Signum joins them with `\n###\n`). */
        textArguments?: (string | null)[] | null;
        alertDate?: Temporal.PlainDateTime | null;
        createdBy?: Lite<UserEntity> | null;
        title?: string | null;
        recipient?: Lite<UserEntity> | null;
        linkTarget?: Lite<Entity> | null;
        groupTarget?: Lite<Entity> | null;
        avoidSendMail?: boolean;
    }

    /**
     * Signum's `CreateAlert(entity, alertType, …)`. Returns null when the module was never started, so a
     * caller can raise alerts unconditionally (Signum's same contract).
     */
    export async function createAlert(
        target: Entity | Lite<Entity>,
        alertType: AlertTypeSymbol,
        options: CreateAlertOptions = {},
    ): Promise<AlertEntity | null> {
        if (!started)
            return null;

        const lite = (target instanceof Entity ? target.toLite() : target) as Lite<Entity>;
        const toStr = lite.toString();

        // Signum lifts type authorization + the save-operation guard here (see the header); ExecutionMode
        // .global is altea's equivalent: a SYSTEM write, not the current user's.
        return await ExecutionMode.global(async () => {
            const alert = AlertEntity.create({
                alertDate: options.alertDate ?? Clock.now,
                createdBy: options.createdBy ?? UserHolder.currentUserLite() as Lite<UserEntity> | null,
                titleField: options.title ?? null,
                textArguments: options.textArguments?.join("\n###\n") ?? null,
                textField: options.text ?? null,
                target: lite,
                targetToString: toStr == null ? null : toStr.substring(0, 200),
                linkTarget: options.linkTarget ?? null,
                groupTarget: options.groupTarget ?? null,
                alertType,
                recipient: options.recipient ?? null,
                avoidSendMail: options.avoidSendMail ?? false,
                state: AlertState.Saved,
            });
            await alert.save();
            return alert;
        });
    }

    /** Signum's `CreateAlertForceNew` — raise the alert in its OWN transaction, so it survives a rollback
     *  of whatever is going on around it (a failing operation that still wants to leave a notice). */
    export async function createAlertForceNew(
        target: Entity | Lite<Entity>,
        alertType: AlertTypeSymbol,
        options: CreateAlertOptions = {},
    ): Promise<AlertEntity | null> {
        if (!started)
            return null;
        return await Transaction.forceNew(() => createAlert(target, alertType, options));
    }

    // ---- Attending / deleting ---------------------------------------------------------------------------

    /** Signum's `AttendAllAlerts(target, alertType)` — a set-based UPDATE, not one save per row. */
    export async function attendAllAlerts(target: Lite<Entity>, alertType: AlertTypeSymbol): Promise<void> {
        const now = Clock.now;
        const by = UserHolder.currentUserLite() as Lite<UserEntity> | null;
        await ExecutionMode.global(() => table(AlertEntity)
            .filter(a => a.target!.is(target) && a.alertType!.is(alertType) && a.state == AlertState.Saved)
            .executeUpdate(a => ({ state: AlertState.Attended, attendedDate: now, attendedBy: by })));
    }

    /** Signum's `DeleteAllAlerts(target)` — both the alerts ABOUT it and the ones LINKING to it. */
    export async function deleteAllAlerts(target: Lite<Entity>): Promise<void> {
        await ExecutionMode.global(async () => {
            await table(AlertEntity).filter(a => a.target!.is(target)).executeDelete();
            await table(AlertEntity).filter(a => a.linkTarget!.is(target)).executeDelete();
        });
    }

    /** Signum's `DeleteUnattendedAlerts(target, alertType, recipient?)`. */
    export async function deleteUnattendedAlerts(
        target: Lite<Entity>,
        alertType: AlertTypeSymbol,
        recipient?: Lite<UserEntity> | null,
    ): Promise<void> {
        await ExecutionMode.global(async () => {
            if (recipient == null)
                await table(AlertEntity)
                    .filter(a => a.state == AlertState.Saved && a.target!.is(target) && a.alertType!.is(alertType))
                    .executeDelete();
            else
                await table(AlertEntity)
                    .filter(a => a.state == AlertState.Saved && a.target!.is(target) && a.alertType!.is(alertType)
                        && a.recipient!.is(recipient))
                    .executeDelete();
        });
    }

    // ---- Row-level conditions ---------------------------------------------------------------------------

    /** Signum's `RegisterCreatorTypeCondition` — "the alerts I raised". */
    export function registerCreatorTypeCondition(typeCondition: TypeConditionSymbol): void {
        TypeConditionLogic.registerCompile(AlertEntity, typeCondition,
            a => a.createdBy!.is(UserHolder.currentUserLite()));
    }

    /** Signum's `RegisterRecipientTypeCondition` — "the alerts addressed to me". */
    export function registerRecipientTypeCondition(typeCondition: TypeConditionSymbol): void {
        TypeConditionLogic.registerCompile(AlertEntity, typeCondition,
            a => a.recipient!.is(UserHolder.currentUserLite()));
    }

    // ---- The operation graph ----------------------------------------------------------------------------

    function registerAlertGraph(): void {
        graph(AlertEntity, AlertState, g => {
            g.GetState = a => a.state;

            // Signum's ConstructFrom<Entity> — owned by the SOURCE type, which is every entity: registered
            // for each type the app opts in with `AlertsClient`'s `showAlerts`, and here for `Entity` so the
            // operation exists. See CLAUDE.md on ConstructFrom ownership.
            g.ConstructFrom(AlertOperation.CreateAlertFromEntity, {
                entityType: Entity as unknown as Type<Entity>,
                toStates: [AlertState.New],
                construct: (source: Entity) => AlertEntity.create({
                    alertDate: Clock.now,
                    createdBy: UserHolder.currentUserLite() as Lite<UserEntity> | null,
                    recipient: defaultRecipient(),
                    titleField: null,
                    textField: null,
                    target: source.toLite(),
                    alertType: null,
                }),
            });

            g.Construct(AlertOperation.Create, {
                toStates: [AlertState.New],
                construct: () => AlertEntity.create({
                    alertDate: Clock.now,
                    createdBy: UserHolder.currentUserLite() as Lite<UserEntity> | null,
                    recipient: defaultRecipient(),
                    titleField: null,
                    textField: null,
                    target: null,
                    alertType: null,
                }),
            });

            g.Execute(AlertOperation.Save, {
                canBeNew: true,
                canBeModified: true,
                fromStates: [AlertState.New, AlertState.Saved],
                toStates: [AlertState.Saved],
                execute: a => { a.state = AlertState.Saved; },
            });

            g.Execute(AlertOperation.Attend, {
                fromStates: [AlertState.Saved],
                toStates: [AlertState.Attended],
                execute: a => {
                    a.state = AlertState.Attended;
                    a.attendedDate = Clock.now;
                    a.attendedBy = UserHolder.currentUserLite() as Lite<UserEntity> | null;
                },
            });

            g.Execute(AlertOperation.Unattend, {
                fromStates: [AlertState.Attended],
                toStates: [AlertState.Saved],
                execute: a => {
                    a.state = AlertState.Saved;
                    a.attendedDate = null;
                    a.attendedBy = null;
                },
            });

            g.Execute(AlertOperation.Delay, {
                fromStates: [AlertState.Saved],
                toStates: [AlertState.Saved],
                // The new alert date arrives as the operation's argument (the client asks for it first).
                execute: (a, args) => { a.alertDate = args[0] as Temporal.PlainDateTime; },
            });
        }).register();
    }
}

export type { FluentInclude };
