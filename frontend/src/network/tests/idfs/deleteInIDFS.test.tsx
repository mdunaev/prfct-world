import {
  numElementsInRouter,
  StateElement,
  StateElementTypes,
  VerificationStatus,
} from "../../idfs/IDFS";
import { IDFSTestDriver } from "../drivers/idfsTestDriver";

const TEST_DATA: StateElement[] = Array(10)
  .fill(0)
  .map(
    (v, i) =>
      ({
        lookupKey: "lookupKey" + i,
        data: "testHexId" + i,
        type: StateElementTypes.WALLET,
        owner: "testhexid",
        ttd: 0,
      } as StateElement)
  );

describe("deleteInIDFS", () => {
  let driver = new IDFSTestDriver(TEST_DATA);

  beforeEach(async () => {
    await driver.initIDFS();
    await driver.setTestElements();
  });

  // a child router of the root with this number of own elements and no routers below it
  const findLeafRouterKey = async (minElements: number) => {
    for (const [routerKey, routerHexId] of Object.entries(driver.getRootRouter().routers)) {
      const router = await driver.getRouterByHexId(routerHexId);
      if (router.stateElements.length >= minElements && Object.keys(router.routers).length === 0) {
        return routerKey;
      }
    }
    throw new Error("No suitable router in the test tree");
  };

  test("should be called without error for not existed element", async () => {
    await driver.deleteItemInIDFS("test");
    const verifyAllElementsResult = await driver.getAllElementsVerification();
    const allElementsAreFound = Array(TEST_DATA.length).fill(VerificationStatus.FOUND);
    expect(verifyAllElementsResult).toStrictEqual(allElementsAreFound);
  });

  test("should not delete root route", async () => {
    await driver.deleteItemInIDFS(driver.rootHexId);
    const verifyAllElementsResult = await driver.getAllElementsVerification();
    const allElementsAreFound = Array(TEST_DATA.length).fill(VerificationStatus.FOUND);
    expect(verifyAllElementsResult).toStrictEqual(allElementsAreFound);
  });

  test("should not delete routes", async () => {
    const childRoutersHexIds = Object.values(driver.getRootRouter().routers);
    expect(childRoutersHexIds.length).toBeGreaterThan(0);

    await driver.deleteItemListInIDFS(childRoutersHexIds);
    const verificationResults = childRoutersHexIds.map(async (hexId) => {
      return await driver.getRouterVerification(hexId);
    });
    const verifyRoutes = await Promise.all(verificationResults);
    expect(verifyRoutes).toStrictEqual(
      Array(childRoutersHexIds.length).fill(VerificationStatus.FOUND)
    );
  });

  test("should delete element form root route", async () => {
    const rootElements = driver.testHexIDs.slice(0, numElementsInRouter);

    expect(await driver.getRouterElementHexIds(driver.rootHexId)).toStrictEqual(rootElements);

    await driver.deleteItemInIDFS(rootElements[rootElements.length - 1]);

    expect(await driver.getRouterElementHexIds(driver.rootHexId)).toStrictEqual(
      rootElements.slice(0, -1)
    );
  });

  test("should not delete router if it has routes", async () => {
    const rootElements = driver.testHexIDs.slice(0, numElementsInRouter);
    expect(await driver.getRouterElementHexIds(driver.rootHexId)).toStrictEqual(rootElements);

    await driver.deleteItemListInIDFS(rootElements);

    expect(await driver.getElementsVerification(rootElements)).toStrictEqual(
      Array(rootElements.length).fill(VerificationStatus.NOT_FOUND)
    );

    expect(await driver.getRouterVerification(driver.rootHexId)).toStrictEqual(
      VerificationStatus.FOUND
    );

    // the elements below the emptied router are still in the tree
    const childElements = driver.getChildElementHexIds();
    expect(await driver.getElementsVerification(childElements)).toStrictEqual(
      Array(childElements.length).fill(VerificationStatus.FOUND)
    );
  });

  test("should delete empty router after delete last element", async () => {
    const routers = { ...driver.getRootRouter().routers };
    const routerKey = await findLeafRouterKey(1);

    const childElements = await driver.getRouterElementHexIds(routers[routerKey]);
    expect(childElements).toStrictEqual(driver.getExpectedChildElementHexIds(routerKey));

    await driver.deleteItemListInIDFS(childElements);

    const { [routerKey]: deletedRouter, ...otherRouters } = routers;
    expect(driver.getRootRouter().routers).toStrictEqual(otherRouters);
  });

  test("should update only all parent routes ids and size", async () => {
    const cashedRootRouterHexId = driver.rootHexId;
    // 10 elements with 10 symbols of data
    expect(driver.getRootRouter().size).toBe(100);

    const routers = { ...driver.getRootRouter().routers };
    const routerKey = await findLeafRouterKey(2);

    const childElements = await driver.getRouterElementHexIds(routers[routerKey]);
    const childSize = await driver.getRouterSize(routers[routerKey]);
    expect(childSize).toBe(childElements.length * 10);

    await driver.deleteItemInIDFS(childElements[0]);

    // rootRouter has new hexid and size
    expect(driver.rootHexId).not.toBe(cashedRootRouterHexId);
    expect(driver.getRootRouter().size).toBe(90);

    // child router does not have deleted element
    const updatedRouters = driver.getRootRouter().routers;
    expect(await driver.getRouterElementHexIds(updatedRouters[routerKey])).toStrictEqual(
      childElements.slice(1)
    );

    // child router has new id and size
    expect(updatedRouters[routerKey]).not.toBe(routers[routerKey]);
    expect(await driver.getRouterSize(updatedRouters[routerKey])).toBe(childSize - 10);

    // other routers are not changed
    Object.keys(routers)
      .filter((key) => key !== routerKey)
      .forEach((key) => expect(updatedRouters[key]).toBe(routers[key]));
  });
});
