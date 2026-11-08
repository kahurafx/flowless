import { workOrder, workOrderAsset } from "@flowless/db/schema/work-orders";
import { and, eq, inArray, or } from "drizzle-orm";
import type { AssetWorkLookup } from "../../../kernel/work";
import { OPEN_STATUSES } from "../store";

/** Tells other modules which unfinished jobs involve an asset (asked before an asset is deleted). */
export const workOrderAssetWork: AssetWorkLookup = {
  async openWorkOn(tx, assetId) {
    return tx
      .selectDistinct({ code: workOrder.code, title: workOrder.title })
      .from(workOrder)
      .leftJoin(workOrderAsset, and(eq(workOrderAsset.organizationId, workOrder.organizationId), eq(workOrderAsset.workOrderId, workOrder.id)))
      .where(and(inArray(workOrder.status, [...OPEN_STATUSES]), or(eq(workOrder.assetId, assetId), eq(workOrderAsset.assetId, assetId))));
  },
};
