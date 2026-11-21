import { IDFSTestDriver } from "../drivers/idfsTestDriver";
import { runActions } from "../../consensus/runActions";
import { rootUsers, supportNodes } from "../../consensus/constants";
import { Action } from "../../interfaces";
import * as IDFS from "../../idfs/IDFS";
import { StateElement } from "../../idfs/IDFS";

const pushToIdfsTreeMock = jest.fn();

const getMintAction = (author: string): Action => ({
  from: author,
  type: "mint",
  ttr: 100000,
  data: {
    hexid: author,
    value: "1000000",
    nonce: 10000,
    data: "",
  },
});

const pushedOwners: string[] = [];

const initMocks = () => {
  jest.spyOn(IDFS, "pushToIdfsTree").mockImplementation(
    pushToIdfsTreeMock.mockImplementation((item: StateElement) => {
      pushedOwners.push(item.owner);
      return { hexid: "", size: 1, affectedRouters: [] };
    })
  );
};

describe("completeActions loop", () => {
  let driver = new IDFSTestDriver([]);

  beforeEach(async () => {
    await driver.initIDFS();
    await driver.setTestElements();
    initMocks();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // every node must run the actions of a block in the same order to get the same state
  test("should run all actions in the order of author ids", async () => {
    // only these authors may mint outside a development build
    const authors = [...rootUsers, ...supportNodes];
    const sortedAuthors = [...authors].sort();

    const actions: { [authorHexid: string]: Action } = {};
    [...sortedAuthors].reverse().forEach((author) => {
      actions[author] = getMintAction(author);
    });
    expect(Object.keys(actions)).not.toStrictEqual(sortedAuthors);

    const { completedActions } = runActions({
      actions,
      initialRouterHexID: driver.rootHexId,
      authorWallet: undefined,
    });

    expect(pushedOwners).toStrictEqual(sortedAuthors);
    expect(completedActions).toStrictEqual(sortedAuthors);
  });
});
