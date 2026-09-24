import { type RouteObject } from 'react-router';
import { BaseEntity, type Type } from '../data/entity';
import { Navigator } from './Navigator';
import { Finder } from './Finder';
import { Operations } from './Operations';
import { QuickLinkClient } from './QuickLinkClient';
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
}
