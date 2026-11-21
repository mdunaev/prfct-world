import {
  deleteInIDFS,
  findPathToElementInIDFS,
  getRootHexid,
  initRootRouter,
  lostInIDFS,
  numElementsInRouter,
  pushToIdfsTree,
  Router,
  StateElement,
  verifyElementInIDFS,
  verifyRouterInIDFS,
} from "../../idfs/IDFS";
import { getHashFromData, getHexPosition, maxPositionValue } from "../../crypto/crypto";
import { getElementFromDB, getRouterFromDB } from "../../idfs/idfsDB";

// IDFS.tsx creates its root router one animation frame after it is loaded.
// Wait for that once, so it can not reset the tree in the middle of the first test.
const idfsStarted = new Promise((resolve) => setTimeout(resolve, 50));

export class IDFSTestDriver {
  testHexIDs: string[] = [];
  testData: StateElement[];

  constructor(testData: StateElement[]) {
    this.testData = testData;
  }

  // the root is read from the tree itself: the update stream is delivered a frame later
  get rootHexId() {
    return getRootHexid();
  }

  async initIDFS() {
    await idfsStarted;
    await initRootRouter();
  }

  async setTestElements() {
    this.testHexIDs = this.testData.map(getHashFromData);
    for (const stateElement of this.testData) {
      await this.pushElementToTree(stateElement);
    }
  }

  async pushElementToTree(element: StateElement) {
    await pushToIdfsTree(element);
  }

  getRootRouter() {
    const rootRouter = getRouterFromDB(this.rootHexId);
    if (!rootRouter) {
      throw new Error("Root Router is undefined");
    }
    return rootRouter;
  }

  async getRouterByHexId(hesId: string) {
    const router = await getRouterFromDB(hesId);
    if (!router) {
      throw new Error(`Router ${hesId} is undefined`);
    }
    return router;
  }

  // the key of the child router that an element goes to from a router of this layer
  getChildRouterKey(hexId: string, layer: number = 0) {
    const routerLength = maxPositionValue / numElementsInRouter ** (layer + 1);
    return layer + 1 + "/" + Math.floor(getHexPosition(hexId) / routerLength);
  }

  // elements that do not fit into the root router
  getChildElementHexIds() {
    return this.testHexIDs.slice(numElementsInRouter);
  }

  // elements that the tree rules put into this child router of the root
  getExpectedChildElementHexIds(childRouterKey: string) {
    return this.getChildElementHexIds()
      .filter((hexId) => this.getChildRouterKey(hexId) === childRouterKey)
      .slice(0, numElementsInRouter);
  }

  async getElementVerification(elementsHexId: string) {
    return await verifyElementInIDFS(elementsHexId);
  }

  async getAllElementsVerification() {
    return await this.getElementsVerification(this.testHexIDs);
  }

  async getElementsVerification(elementsHexIds: string[]) {
    const verifyResult = elementsHexIds.map(
      async (hexId) => await this.getElementVerification(hexId)
    );
    return await Promise.all(verifyResult);
  }

  async deleteItemInIDFS(hexId: string) {
    await deleteInIDFS(hexId);
  }

  async deleteItemListInIDFS(hexIds: string[]) {
    for (const hexId of hexIds) {
      await this.deleteItemInIDFS(hexId);
    }
  }

  async getRouterElementHexIds(routerHexId: string) {
    const router = await this.getRouterByHexId(routerHexId);
    return router.stateElements.map((element) => element.hexId);
  }

  async getRouterSize(routerHexId: string) {
    const router = await this.getRouterByHexId(routerHexId);
    return router.size;
  }

  async getRouterRoutesHexIds(routerHexId: string): Promise<string[]> {
    const router = await this.getRouterByHexId(routerHexId);
    return Object.values(router.routers);
  }

  async getRouterVerification(routerHexId: string, routerItem?: Router) {
    const router = routerItem ? routerItem : await this.getRouterByHexId(routerHexId);
    return await verifyRouterInIDFS(routerHexId, router.layer, router.shift);
  }

  async getRouterListVerification(routersHexIds: string[]) {
    const newRoutesIDs = routersHexIds.map(
      async (hexId) => await this.getRouterVerification(hexId)
    );
    return await Promise.all(newRoutesIDs);
  }

  async findPathToElement(hexId: string) {
    const foundRouters = await findPathToElementInIDFS(hexId);
    return foundRouters.map(getHashFromData);
  }

  async lostItem(hexId: string) {
    await lostInIDFS(hexId);
  }

  async getElementFromIDFS(hexId: string) {
    return await getElementFromDB(hexId);
  }
}
