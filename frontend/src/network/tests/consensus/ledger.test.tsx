import { state } from "../../consensus/consensus";
import { rootUsers, stepSize } from "../../consensus/constants";
import { runActions } from "../../consensus/runActions";
import { timePointsToTDD, ttdToTimePoints } from "../../consensus/utils";
import { getHashFromData } from "../../crypto/crypto";
import {
  deleteInIDFS,
  findPathToElementInIDFS,
  getRootHexid,
  initRootRouter,
  pushToIdfsTree,
  StateElement,
  StateElementTypes,
  VerificationStatus,
  verifyElementInIDFS,
} from "../../idfs/IDFS";
import { getElementFromDB, getRouterFromDB } from "../../idfs/idfsDB";
import { Action } from "../../interfaces";

const ALICE = "aa".repeat(32);
const BOB = "bb".repeat(32);
const CAROL = "cc".repeat(32);

const BLOCK_NUMBER = 100;
const TTR = BLOCK_NUMBER + 1;

const getWallet = (props?: Partial<StateElement>): StateElement => ({
  type: StateElementTypes.WALLET,
  lookupKey: "TEST_LOOK_UP_KEY",
  owner: ALICE,
  ttd: TTR + 1000,
  createdAt: 50,
  data: "",
  ...props,
});

const getTreeElements = (routerHexid: string = getRootHexid()): StateElement[] => {
  const router = getRouterFromDB(routerHexid);
  if (!router) return [];
  return [
    ...router.stateElements.map((info) => getElementFromDB(info.hexId) as StateElement),
    ...Object.values(router.routers).flatMap((hexid) => getTreeElements(hexid)),
  ];
};

const getWalletsOf = (owner: string) =>
  getTreeElements().filter((wallet) => wallet.owner === owner);

const getTimePoints = (wallet: StateElement) =>
  ttdToTimePoints(wallet.ttd, wallet.data?.length, TTR);

const split = (from: string, wallet: StateElement, amount: number, data = ""): Action => ({
  from,
  type: "split",
  ttr: TTR,
  data: { wallet: getHashFromData(wallet), receiver: BOB, amount: String(amount), data },
});

describe("ledger", () => {
  beforeEach(() => {
    state.blockNumber = BLOCK_NUMBER;
    initRootRouter();
  });

  describe("deleteInIDFS", () => {
    test("should keep wallets below a router that lost its own elements", () => {
      const wallets = Array(60)
        .fill(0)
        .map((v, i) => getWallet({ lookupKey: "key" + i }));
      wallets.forEach((wallet) => pushToIdfsTree(wallet));
      const hexids = wallets.map(getHashFromData);

      // an inner router that holds elements and has child routers
      const innerRouter = hexids
        .map((hexid) => findPathToElementInIDFS(hexid))
        .filter((path) => path.length > 1)
        .map((path) => path[path.length - 1])
        .find((router) => Object.keys(router.routers).length > 0);
      expect(innerRouter).toBeDefined();

      const deleted = innerRouter!.stateElements.map((info) => info.hexId);
      deleted.forEach((hexid) => expect(deleteInIDFS(hexid)).toBeDefined());

      hexids.forEach((hexid) => {
        expect(verifyElementInIDFS(hexid)).toBe(
          deleted.includes(hexid) ? VerificationStatus.NOT_FOUND : VerificationStatus.FOUND
        );
      });
    });

    test("should unlink a router that has no elements and no routers", () => {
      const wallets = Array(4)
        .fill(0)
        .map((v, i) => getWallet({ lookupKey: "key" + i }));
      wallets.forEach((wallet) => pushToIdfsTree(wallet));
      expect(Object.keys(getRouterFromDB(getRootHexid())!.routers).length).toBe(1);

      const childWallet = wallets.find(
        (wallet) => findPathToElementInIDFS(getHashFromData(wallet)).length > 1
      ) as StateElement;
      deleteInIDFS(getHashFromData(childWallet));

      expect(Object.keys(getRouterFromDB(getRootHexid())!.routers).length).toBe(0);
    });
  });

  describe("split", () => {
    test("should give the receiver a wallet for each of two equal payments", () => {
      const aliceWallet = getWallet({ owner: ALICE });
      const carolWallet = getWallet({ owner: CAROL });
      pushToIdfsTree(aliceWallet);
      pushToIdfsTree(carolWallet);

      const { completedActions } = runActions({
        actions: {
          [ALICE]: split(ALICE, aliceWallet, 100),
          [CAROL]: split(CAROL, carolWallet, 100),
        },
        initialRouterHexID: getRootHexid(),
      });

      expect(completedActions).toStrictEqual([ALICE, CAROL]);
      const bobWallets = getWalletsOf(BOB);
      expect(bobWallets.length).toBe(2);
      expect(bobWallets.map(getTimePoints)).toStrictEqual([99, 99]);
      bobWallets.forEach((wallet) => {
        expect(verifyElementInIDFS(getHashFromData(wallet))).toBe(VerificationStatus.FOUND);
      });
    });

    test.each([0, stepSize, stepSize + 1, 1200])(
      "should keep the balance of a sender with %i symbols of data",
      (size) => {
        const wallet = getWallet({ data: "x".repeat(size) });
        pushToIdfsTree(wallet);
        const before = getTimePoints(wallet);
        const factor = Math.ceil((size || stepSize) / stepSize);

        const { completedActions } = runActions({
          actions: { [ALICE]: split(ALICE, wallet, 100) },
          initialRouterHexID: getRootHexid(),
        });

        expect(completedActions).toStrictEqual([ALICE]);
        const after = getTimePoints(getWalletsOf(ALICE)[0]);
        // the sender pays the amount, and less than one step of life is lost to rounding
        expect(before - 100 - after).toBeGreaterThanOrEqual(0);
        expect(before - 100 - after).toBeLessThan(factor);
        // the receiver gets the amount minus 1% fee
        expect(getWalletsOf(BOB).map(getTimePoints)).toStrictEqual([99]);
      }
    );

    test("should charge the receiver for the data of the new wallet", () => {
      const wallet = getWallet();
      pushToIdfsTree(wallet);

      runActions({
        actions: { [ALICE]: split(ALICE, wallet, 200, "x".repeat(stepSize + 1)) },
        initialRouterHexID: getRootHexid(),
      });

      const bobWallet = getWalletsOf(BOB)[0];
      // 198 time points, 2 time points for every step
      expect(bobWallet.ttd - TTR).toBe(99);
      expect(getTimePoints(bobWallet)).toBe(198);
    });
  });

  describe("merge", () => {
    test.each([0, stepSize + 1, 1200])(
      "should keep the balance of wallets with %i symbols of data",
      (size) => {
        const main = getWallet({ lookupKey: "main", data: "x".repeat(size) });
        const source = getWallet({ lookupKey: "source", data: "y".repeat(size), ttd: TTR + 501 });
        pushToIdfsTree(main);
        pushToIdfsTree(source);
        const before = getTimePoints(main) + getTimePoints(source);

        const { completedActions } = runActions({
          actions: {
            [ALICE]: {
              from: ALICE,
              type: "merge",
              ttr: TTR,
              data: { main: getHashFromData(main), source: getHashFromData(source) },
            },
          },
          initialRouterHexID: getRootHexid(),
        });

        expect(completedActions).toStrictEqual([ALICE]);
        const aliceWallets = getWalletsOf(ALICE);
        expect(aliceWallets.length).toBe(1);
        expect(getTimePoints(aliceWallets[0])).toBe(before);
      }
    );
  });

  describe("time points", () => {
    test.each([0, 1, stepSize, stepSize + 1, 1200])(
      "should convert steps to time points and back for %i symbols of data",
      (size) => {
        const timePoints = ttdToTimePoints(BLOCK_NUMBER + 100, size, BLOCK_NUMBER);
        expect(timePointsToTDD(timePoints, size, BLOCK_NUMBER)).toBe(BLOCK_NUMBER + 100);
      }
    );
  });

  describe("mint", () => {
    test("should not mint the same wallet twice", () => {
      // only root users may mint outside a development build
      const ROOT_USER = rootUsers[0];
      const mint: Action = {
        from: ROOT_USER,
        type: "mint",
        ttr: TTR,
        data: { hexid: BOB, value: "1000", data: "" },
      };
      const run = () =>
        runActions({ actions: { [ROOT_USER]: mint }, initialRouterHexID: getRootHexid() });

      expect(run().completedActions).toStrictEqual([ROOT_USER]);
      expect(run().completedActions).toStrictEqual([]);
      expect(getWalletsOf(BOB).length).toBe(1);
    });
  });
});
