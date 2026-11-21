import {
  numElementsInRouter,
  StateElement,
  StateElementTypes,
  VerificationStatus,
} from "../../idfs/IDFS";
import { getHashFromData } from "../../crypto/crypto";
import { IDFSTestDriver } from "../drivers/idfsTestDriver";

const TEST_DATA: StateElement[] = Array(10)
  .fill(0)
  .map((v, i) => ({
    lookupKey: "lookupKey" + (i + 1),
    data: "testHexId" + (i + 1),
    type: StateElementTypes.WALLET,
    owner: "testhexid",
    ttd: 0,
    createdAt: 140000000,
  }));

describe("pushToIdfsTree", () => {
  let driver = new IDFSTestDriver(TEST_DATA);

  beforeEach(async () => {
    await driver.initIDFS();
    await driver.setTestElements();
  });

  test("should verified all pushed elements", async () => {
    const verifyElements = await driver.getAllElementsVerification();
    expect(verifyElements).toStrictEqual(Array(TEST_DATA.length).fill(VerificationStatus.FOUND));
  });

  test("should create and verify routes in root router", async () => {
    // one child router for every part of the hex space that got an element
    const expectedRouterKeys = [
      ...new Set(driver.getChildElementHexIds().map((hexId) => driver.getChildRouterKey(hexId))),
    ];
    expect(Object.keys(driver.getRootRouter().routers).sort()).toStrictEqual(
      expectedRouterKeys.sort()
    );

    const routersList = await driver.getRouterRoutesHexIds(driver.rootHexId);
    const verifyRoutes = await driver.getRouterListVerification(routersList);
    expect(verifyRoutes).toStrictEqual(Array(routersList.length).fill(VerificationStatus.FOUND));
  });

  test("should put first elements in root router", async () => {
    expect(await driver.getRouterElementHexIds(driver.rootHexId)).toStrictEqual(
      driver.testHexIDs.slice(0, numElementsInRouter)
    );
  });

  test("should construct right tree", async () => {
    const routers = driver.getRootRouter().routers;
    expect(Object.keys(routers).length).toBeGreaterThan(1);

    for (const [routerKey, routerHexId] of Object.entries(routers)) {
      expect(await driver.getRouterElementHexIds(routerHexId)).toStrictEqual(
        driver.getExpectedChildElementHexIds(routerKey)
      );
    }
  });

  test("should update only parent routes ids and size", async () => {
    // 9 elements with 10 symbols of data and one with 11
    expect(driver.getRootRouter().size).toBe(101);

    const routers = { ...driver.getRootRouter().routers };

    // push new element to tree
    const newElement: StateElement = {
      lookupKey: "lookupKey11",
      data: "testHexId11",
      type: StateElementTypes.WALLET,
      owner: "testhexid",
      ttd: 0,
      createdAt: 140000000,
    };
    const newElementHexId = getHashFromData(newElement);
    const newElementRouterKey = driver.getChildRouterKey(newElementHexId);
    const sizeBefore = routers[newElementRouterKey]
      ? await driver.getRouterSize(routers[newElementRouterKey])
      : 0;

    await driver.pushElementToTree(newElement);

    // rootRouter has new size
    expect(driver.getRootRouter().size).toBe(112);

    const updatedRouters = driver.getRootRouter().routers;

    // the new element is below its child router
    expect(await driver.getElementVerification(newElementHexId)).toBe(VerificationStatus.FOUND);
    expect((await driver.findPathToElement(newElementHexId))[1]).toBe(
      updatedRouters[newElementRouterKey]
    );

    // child router has new id and size
    expect(updatedRouters[newElementRouterKey]).not.toBe(routers[newElementRouterKey]);
    expect(await driver.getRouterSize(updatedRouters[newElementRouterKey])).toBe(sizeBefore + 11);

    // other routers are not changed
    Object.keys(updatedRouters)
      .filter((routerKey) => routerKey !== newElementRouterKey)
      .forEach((routerKey) => expect(updatedRouters[routerKey]).toBe(routers[routerKey]));
  });
});
