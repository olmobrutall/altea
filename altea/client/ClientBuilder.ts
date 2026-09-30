import { type RouteObject } from 'react-router';
import { BaseEntity, Entity, type Type } from '../data/entity';
import type { EntityPack } from '../data/entityPack';
import type { PropertyRoute } from '../data/propertyRoute';
import type {
  ExecuteSymbol, DeleteSymbol, ConstructSymbol, Simple, From, FromMany,
} from '../data/operations';
import { Navigator } from './Navigator';
import { Constructor } from './Constructor';
import { Finder } from './Finder';
import {
  Operations, EntityOperationSettings, ConstructorOperationSettings, ContextualOperationSettings,
  type EntityOperationOptions, type ConstructorOperationOptions, type ContextualOperationOptions,
} from './Operations';
import { QuickLinkClient, type QuickLink } from './QuickLinkClient';
import { ExceptionClient } from './Exceptions/ExceptionClient';
import { TypeEntityClient } from './TypeEntityClient';
import { EntitySettings, type EntitySettingsOptions, type ViewModule } from './EntitySettings';
import { QueryTokenString, createTokenFunction, type TokenFunction } from './QueryTokenString';

// The client-side mirror of the server's SchemaBuilder (see eastwind/app/starter.server.ts). Where the
// server threads a single `sb` through every module's `XLogic.start(sb)`, the client threads a single
// `cb` through every domain's `XClient.start(cb)`. This is the ONE bootstrap object: it owns the app's
// route table and runs the framework client init (Operations / Navigator / Finder), then each domain
// registers its per-entity view + query settings against it via `cb.configure(Entity)`.
//
//   const cb = new ClientBuilder(routes);
//   cb.startFramework();                 // Operations/Navigator/Finder.start (push /view,/create,/find)
//   EmployeesClient.start(cb);
//   ...
//
//   cb.configure(CompanyEntity)
//     .withView(c => import('./Company'))
//     .withQuerySettings(token => ({ defaultColumns: [token(a => a.companyName)] }));
export class ClientBuilder {
  /** The app route table. `startFramework` and each ImportComponent-backed route are pushed here;
   * the host (MainPublic) mounts it into the router. Mirrors how the server's `sb.schema` collects
   * tables — a single mutable collector threaded through every module. */
  routes: RouteObject[];

  constructor(routes: RouteObject[] = []) {
    this.routes = routes;
  }

  /** Run the framework client modules in Southwind's MainAdmin order (Operations first, then Navigator
   * and Finder). Each pushes its own ImportComponent routes (/view, /create, /find) onto `this.routes`.
   * Call once, before any domain `start(cb)`. */
  startFramework(): void {
    // QuickLinks first so its widget / context-menu / cell-format registrations are in place before
    // Operations.start pushes the global operation-log quick link (Signum's MainAdmin ordering).
    QuickLinkClient.start();
    Operations.start();
    Navigator.start({ routes: this.routes });
    Finder.start({ routes: this.routes });
    // Framework exception UI (Signum's ExceptionClient.start): registers the ExceptionEntity view the
    // ErrorModal links to. In the framework init (not per-app) since the framework's ErrorModal depends
    // on it. Also registers ExceptionEntity's client TypeInfo (fixes "No TypeInfo for 'exception'").
    ExceptionClient.start();
    // The type table's query settings — chiefly the pinned filter that keeps `@part` rows out of the
    // picker `EntityBase.chooseType` opens for an `@implementedByAll` reference. Here rather than in the
    // app's MainAdmin (where CultureInfoClient / SystemEventLogClient live) because it is a default on a
    // picker the FRAMEWORK opens: an app that forgot the call would get part rows in every one of them.
    TypeEntityClient.start(this);
  }

  /** Begin a fluent per-entity registration rooted at `type` (Signum registered view + query settings
   * with two separate calls; here they chain off one `configure`). */
  configure<T extends BaseEntity>(type: Type<T>): EntityClientBuilder<T> {
    return new EntityClientBuilder<T>(type);
  }
}

// The fluent per-entity registration returned by `ClientBuilder.configure`. Each method registers into
// the framework registry it belongs to and returns `this` so calls chain. The token function passed to
// `withQuerySettings` is ALWAYS rooted at the configured `T` (even when the returned settings override
// `queryName` to point at another query — e.g. a manual/row-model union query).
export class EntityClientBuilder<T extends BaseEntity> {
  constructor(private type: Type<T>) {}

  /** Register the entity's view module with Navigator (Signum's
   * `Navigator.addSettings(new EntitySettings(Type, getViewModule, options))`). */
  withView(getViewModule: (entity: T) => Promise<ViewModule<T>>, options?: EntitySettingsOptions<T>): this {
    // EntitySettings is invariant on its entity type (getViewPromise), so EntitySettings<T> for a
    // generic T isn't structurally assignable to the registry's EntitySettings<BaseEntity>. The cast is
    // sound — `T extends BaseEntity` and the settings only ever handle entities of type T.
    Navigator.addSettings(new EntitySettings(this.type, getViewModule, options) as unknown as EntitySettings<BaseEntity>);
    return this;
  }

  /** Register the entity's settings with NO view module (Signum's `new EntitySettings(Type, undefined, options)`):
   * it is viewed through the auto-generated AutoComponent, or not at all (`isViewable: "Never"`). */
  withSettings(options?: EntitySettingsOptions<T>): this {
    Navigator.addSettings(new EntitySettings(this.type, undefined, options) as unknown as EntitySettings<BaseEntity>);
    return this;
  }

  /** Register Finder query settings (Signum's `Finder.addSettings({ queryName, ... })`). `queryName`
   * defaults to the configured type; the builder may override it in its returned object. */
  withQuerySettings(builder?: (token: TokenFunction<T>) => Partial<Finder.QuerySettings>): this {
    const settings = builder ? builder(createTokenFunction<T>(new QueryTokenString(""))) : {};
    Finder.addSettings({ queryName: this.type, ...settings } as Finder.QuerySettings);
    return this;
  }

  /** How a NEW `T` is built client-side — its default values (Signum's `Constructor.registerConstructor`).
   * Not an operation: it runs before anything reaches the server. */
  withConstructor(
    constructor: (props?: Partial<T>, pr?: PropertyRoute) => T | Promise<T | EntityPack<T> | undefined>,
    options?: { override?: boolean }): this {
    Constructor.registerConstructor(this.type, constructor, options);
    return this;
  }

  // ---- operations -----------------------------------------------------------------------------------
  //
  // One method per operation KIND, because the kind cannot be recovered at runtime: the `Simple` /
  // `From` / `FromMany` markers are erased, and the metadata carrying `operationType` loads after every
  // module's `start(cb)`. Picking the wrong settings class crashes far from the call, so the symbol's
  // static type picks it here.
  //
  // `T` is the type that OWNS the operation (the server's `sb.include(T)`) — for the construct kinds the
  // one PRODUCED, not the source. The source is inferred as `S`, so `eoc.entity` is typed without a cast.
  //
  // `contextual` / `contextualFromMany` / `cell` stay nested options: they are read off the owning
  // EntityOperationSettings, never looked up in the registry.

  withConstructorOperation(
    operation: ConstructSymbol<T & Entity, Simple>,
    options: ConstructorOperationOptions<T & Entity>): this {
    Operations.addSettings(new ConstructorOperationSettings<T & Entity>(operation, options));
    return this;
  }

  /** `options` is typed on the SOURCE `S`, where the button sits. */
  withConstructFromOperation<S extends Entity>(
    operation: ConstructSymbol<T & Entity, From<S>>,
    options: EntityOperationOptions<S>): this {
    Operations.addSettings(new EntityOperationSettings<S>(operation as ConstructSymbol<Entity, From<S>>, options));
    return this;
  }

  /** Lives only in the search control's contextual menu, so this is its whole registration. */
  withContextualOperation<S extends Entity>(
    operation: ConstructSymbol<T & Entity, FromMany<S>>,
    options: ContextualOperationOptions<S>): this {
    Operations.addSettings(new ContextualOperationSettings<S>(operation as ConstructSymbol<Entity, FromMany<S>>, options));
    return this;
  }

  withEntityOperation(
    operation: ExecuteSymbol<T & Entity> | DeleteSymbol<T & Entity>,
    options: EntityOperationOptions<T & Entity>): this {
    Operations.addSettings(new EntityOperationSettings<T & Entity>(operation, options));
    return this;
  }

  withQuickLink(quickLink: QuickLink<T & Entity>): this {
    QuickLinkClient.registerQuickLink(this.type as Type<T & Entity>, quickLink);
    return this;
  }
}
