import { reflect } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity } from "@altea/altea/data/decorators";
import { CaseActivityEntity } from "./CaseActivity";
import { WorkflowGatewayDirection } from "./WorkflowNodes";

// Port of Signum.Workflow's CaseJunction.cs — "only for split and join": when a parallel gateway fans a case
// out or back in, the plain `previous` link cannot express the many-to-many, so the pairs are recorded here.

@reflect
@entity("System", "Transactional")
export class CaseJunctionEntity extends Entity {

    direction: WorkflowGatewayDirection;

    from: Lite<CaseActivityEntity>;

    to: Lite<CaseActivityEntity>;
}
