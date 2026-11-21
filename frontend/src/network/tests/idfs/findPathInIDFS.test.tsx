import { StateElement, StateElementTypes } from "../../idfs/IDFS";
import { IDFSTestDriver } from "../drivers/idfsTestDriver";

const TEST_DATA: StateElement[] = Array(7)
  .fill(0)
  .map((v, i) => ({
    lookupKey: "lookupKey" + i,
    data: "testHexId" + i,
    type: StateElementTypes.WALLET,
    owner: "testhexid",
    ttd: 0,
    createdAt: 140000000,
  }));

describe("findPathInIDFS", () => {
  let driver = new IDFSTestDriver(TEST_DATA);

  beforeEach(async () => {
    await driver.initIDFS();
    await driver.setTestElements();
  });

  // the first element that did not fit into the root router is always right below the root
  const getChildElement = () => {
    const hexId = driver.getChildElementHexIds()[0];
    const routerHexId = driver.getRootRouter().routers[driver.getChildRouterKey(hexId)];
    return { hexId, routerHexId };
  };

  test("should return element path from child router", async () => {
    const { hexId, routerHexId } = getChildElement();
    expect(routerHexId).toBeDefined();
    expect(await driver.findPathToElement(hexId)).toStrictEqual([driver.rootHexId, routerHexId]);
  });

  test("should return empty path for not added hexId", async () => {
    const pathToNotExistedElement = await driver.findPathToElement("not existed");
    expect(pathToNotExistedElement).toStrictEqual([]);
  });

  test("should return empty path for deleted element", async () => {
    const { hexId: testElementHexId, routerHexId } = getChildElement();
    const foundRouters = await driver.findPathToElement(testElementHexId);
    expect(foundRouters).toStrictEqual([driver.rootHexId, routerHexId]);

    await driver.deleteItemInIDFS(testElementHexId);
    const foundRoutersAfterDelete = await driver.findPathToElement(testElementHexId);
    expect(foundRoutersAfterDelete).toStrictEqual([]);
  });

  test("should return empty path for lost route elements", async () => {
    const { hexId: testElementHexId, routerHexId: firstRouterInRoot } = getChildElement();

    const foundRoutersToElement = await driver.findPathToElement(testElementHexId);
    expect(foundRoutersToElement).toStrictEqual([driver.rootHexId, firstRouterInRoot]);

    // lost router
    await driver.lostItem(firstRouterInRoot);

    const foundRoutersToElementAfterLost = await driver.findPathToElement(testElementHexId);
    expect(foundRoutersToElementAfterLost).toStrictEqual([]);
  });
});
