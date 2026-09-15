import { entity, implementedBy } from "@altea/altea/data/decorators";
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import { reflect } from "@altea/altea/data/reflection";

// Southwind's `OrderEntity.Customer` in miniature: an `@implementedBy` reference whose implementations
// each carry the SAME EMBEDDED field, so a query can navigate THROUGH the polymorphic reference INTO
// the embedded and out to one of its members (`o.customer.address.country`).
//
// That is the one shape where the binder used to give up: dispatching a member over an IB builds one
// branch per implementation and combines them, and combining two EMBEDDED branches has no scalar
// answer — the combination has to be pushed INSIDE the embedded, one CASE per field, or the next
// member access lands on a CASE of objects and cannot bind.
//
// Declared in the test tree and included only by the binder suite's OWN schema, so no DB-backed suite
// gains a table and none needs regenerating (same rule as `castProbe`).

@reflect
export class ProbeAddressEmbedded extends EmbeddedEntity {
    street: string | null;
    city: string | null;
    country: string | null;
}

// altea has no runtime interface type (see `IAuthorEntity` in artist.ts): this is the compile-time
// contract that lets a polymorphic `customer` reference navigate what both implementations share.
export interface IProbeCustomerEntity extends Entity {
    name: string;
    address: ProbeAddressEmbedded;
}

@entity("Main", "Transactional")
export class ProbeCompanyEntity extends Entity implements IProbeCustomerEntity {
    name: string;
    address: ProbeAddressEmbedded;
}

@entity("Main", "Transactional")
export class ProbePersonEntity extends Entity implements IProbeCustomerEntity {
    name: string;
    address: ProbeAddressEmbedded;
}

@entity("Main", "Transactional")
export class ProbeOrderEntity extends Entity {
    @implementedBy(() => [ProbeCompanyEntity, ProbePersonEntity])
    customer: IProbeCustomerEntity;
}

// A reference the binder can reach the SAME way with only ONE implementation in the list, which takes
// the single-implementation short-circuit in dispatchIb instead of the combining path.
@entity("Main", "Transactional")
export class ProbeSingleOrderEntity extends Entity {
    @implementedBy(() => [ProbeCompanyEntity])
    customer: IProbeCustomerEntity;
}
