import libsodium from "libsodium-wrappers";
import { addNewAction, addNewBlock, bestBlockStream, state } from "../../consensus/consensus";
import { runActions } from "../../consensus/runActions";
import { getActionPayload, isWalletVerified, measureBlock } from "../../consensus/utils";
import {
  changeKeys,
  decryptFrom,
  encryptFor,
  generateKey,
  getHashFromData,
  signData,
  verifyData,
} from "../../crypto/crypto";
import {
  findPathToElementInIDFS,
  getRootHexid,
  initRootRouter,
  pushToIdfsTree,
  StateElement,
  StateElementTypes,
  VerificationStatus,
  verifyElementInIDFS,
} from "../../idfs/IDFS";
import { getElementFromDB, getRouterFromDB, saveToDB } from "../../idfs/idfsDB";
import { Action, Block } from "../../interfaces";

const alice = generateKey();
const bob = generateKey();

const BLOCK_NUMBER = 100;

const getWallet = (props?: Partial<StateElement>): StateElement => ({
  type: StateElementTypes.WALLET,
  lookupKey: "TEST_LOOK_UP_KEY",
  owner: alice.publicKey,
  ttd: 1100,
  createdAt: 50,
  data: "",
  ...props,
});

const getSignedAction = (props: Partial<Action>): Action => {
  const action: Action = {
    from: alice.publicKey,
    type: "merge",
    ttr: BLOCK_NUMBER + 1,
    data: {},
    ...props,
  };
  return { ...action, signature: signData(getActionPayload(action)) };
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("security", () => {
  beforeEach(() => {
    changeKeys(alice);
    state.blockNumber = BLOCK_NUMBER;
    initRootRouter();
  });

  describe("signData", () => {
    test("should verify data signed by the author", () => {
      const data = { some: "data" };
      expect(verifyData(data, signData(data), alice.publicKey)).toBe(true);
    });

    test("should not verify changed data, wrong author or broken signature", () => {
      const data = { some: "data" };
      const signature = signData(data);
      expect(verifyData({ some: "other data" }, signature, alice.publicKey)).toBe(false);
      expect(verifyData(data, signature, bob.publicKey)).toBe(false);
      expect(verifyData(data, undefined, alice.publicKey)).toBe(false);
      expect(verifyData(data, "not a signature", alice.publicKey)).toBe(false);
    });
  });

  describe("signData", () => {
    test("should not verify different data with the same legacy hash", () => {
      // getHashFromData reads a string as raw bytes: "a" + "b" and "\u0161" + "c" give the same bytes
      const data = { receiver: "0123456789abcdef" };
      const collisions = data.receiver
        .split("")
        .map((symbol, i, symbols) => {
          if (i + 1 >= symbols.length) return undefined;
          const changed = [...symbols];
          changed[i] = String.fromCharCode(symbols[i].charCodeAt(0) ^ 0x100);
          changed[i + 1] = String.fromCharCode(symbols[i + 1].charCodeAt(0) ^ 1);
          return { receiver: changed.join("") };
        })
        .filter((changed) => changed && getHashFromData(changed) === getHashFromData(data));

      expect(collisions.length).toBeGreaterThan(0);
      collisions.forEach((changed) => {
        expect(verifyData(changed, signData(data), alice.publicKey)).toBe(false);
      });
    });
  });

  describe("addNewAction", () => {
    test("should add action signed by its author", () => {
      expect(addNewAction(getSignedAction({ ttr: BLOCK_NUMBER + 1 }))).toBe(true);
    });

    test("should not add action without signature", () => {
      const { signature, ...action } = getSignedAction({ ttr: BLOCK_NUMBER + 2 });
      expect(addNewAction(action)).toBe(false);
    });

    test("should not add action signed by somebody else", () => {
      // alice signs an action that claims to be from bob
      const action = getSignedAction({ from: bob.publicKey, ttr: BLOCK_NUMBER + 2 });
      expect(addNewAction(action)).toBe(false);
    });

    test("should not add action changed after signing", () => {
      const action = getSignedAction({ ttr: BLOCK_NUMBER + 2, data: { amount: "1" } });
      expect(addNewAction({ ...action, data: { amount: "1000" } })).toBe(false);
    });

    test("should not add malformed action", () => {
      expect(addNewAction(undefined as any)).toBe(false);
      expect(addNewAction(getSignedAction({ ttr: BLOCK_NUMBER + 2, data: null }))).toBe(false);
      expect(addNewAction(getSignedAction({ ttr: "101" as any }))).toBe(false);
    });
  });

  describe("addNewBlock", () => {
    const getSignedBlock = (author: string, blockNumber = BLOCK_NUMBER): Block => {
      const data = {
        author,
        actions: [],
        initial: getRootHexid(),
        final: getRootHexid(),
        block: blockNumber,
      };
      return { scores: measureBlock(data, true), data, signature: signData(data) };
    };

    test("should select only a block of this round signed by its author", async () => {
      const selectedBlocks: Block[] = [];
      bestBlockStream.on((block) => selectedBlocks.push(block));

      const { signature, ...unsignedBlock } = getSignedBlock(alice.publicKey);
      addNewBlock(unsignedBlock, alice.publicKey);

      // alice signs a block that claims to be from bob
      addNewBlock(getSignedBlock(bob.publicKey), alice.publicKey);

      // a valid block of the previous round is replayed
      addNewBlock(getSignedBlock(alice.publicKey, BLOCK_NUMBER - 1), alice.publicKey);

      await wait(100);
      expect(selectedBlocks).toStrictEqual([]);

      const validBlock = getSignedBlock(alice.publicKey);
      addNewBlock(validBlock, alice.publicKey);

      await wait(100);
      expect(selectedBlocks).toStrictEqual([validBlock]);
    });
  });

  describe("isWalletVerified", () => {
    test("should verify wallet from the tree", () => {
      const wallet = getWallet();
      pushToIdfsTree(wallet);
      const path = findPathToElementInIDFS(getHashFromData(wallet));

      expect(isWalletVerified({ element: wallet, path }, getRootHexid())).toBe(true);
    });

    test("should verify wallet from a child router", () => {
      const wallets = Array(12)
        .fill(0)
        .map((v, i) => getWallet({ lookupKey: "key" + i }));
      wallets.forEach((wallet) => pushToIdfsTree(wallet));

      const deepWallet = wallets.find(
        (wallet) => findPathToElementInIDFS(getHashFromData(wallet)).length > 1
      ) as StateElement;
      const path = findPathToElementInIDFS(getHashFromData(deepWallet));

      expect(isWalletVerified({ element: deepWallet, path }, getRootHexid())).toBe(true);
    });

    test("should not verify wallet that is not in the tree", () => {
      const wallet = getWallet();
      pushToIdfsTree(wallet);
      const path = findPathToElementInIDFS(getHashFromData(wallet));
      const fakeWallet = getWallet({ ttd: 99999999 });

      expect(isWalletVerified({ element: fakeWallet, path }, getRootHexid())).toBe(false);
      expect(isWalletVerified({ element: fakeWallet, path: [] }, getRootHexid())).toBe(false);
      expect(isWalletVerified(undefined, getRootHexid())).toBe(false);
    });

    test("should not throw on malformed proof", () => {
      const wallet = getWallet();
      pushToIdfsTree(wallet);
      const rootRouter = getRouterFromDB(getRootHexid());
      const brokenRouters: any[] = [
        { ...rootRouter, stateElements: "not an array" },
        { ...rootRouter, stateElements: [null] },
        null,
      ];

      brokenRouters.forEach((router) => {
        const rootHexid = getHashFromData(router);
        expect(isWalletVerified({ element: wallet, path: [router] }, rootHexid)).toBe(false);
      });
    });

    test("should not verify wallet from another tree", () => {
      const emptyRootHexid = getRootHexid();
      const wallet = getWallet();
      pushToIdfsTree(wallet);
      const path = findPathToElementInIDFS(getHashFromData(wallet));

      expect(isWalletVerified({ element: wallet, path }, emptyRootHexid)).toBe(false);
    });

    test("should not verify expired wallet", () => {
      const wallet = getWallet();
      pushToIdfsTree(wallet);
      const path = findPathToElementInIDFS(getHashFromData(wallet));
      state.blockNumber = wallet.ttd + 1;

      expect(isWalletVerified({ element: wallet, path }, getRootHexid())).toBe(false);
    });
  });

  describe("runActions", () => {
    const split = (data: any): Action => ({
      from: alice.publicKey,
      type: "split",
      ttr: BLOCK_NUMBER + 1,
      data,
    });

    test("should complete split", () => {
      const wallet = getWallet();
      pushToIdfsTree(wallet);
      const walletHexid = getHashFromData(wallet);

      const { completedActions } = runActions({
        actions: {
          [alice.publicKey]: split({
            wallet: walletHexid,
            receiver: bob.publicKey,
            amount: "900",
            data: "",
          }),
        },
        initialRouterHexID: getRootHexid(),
      });

      expect(completedActions).toStrictEqual([alice.publicKey]);
      const owners = getRouterFromDB(getRootHexid())
        ?.stateElements.map((info) => getElementFromDB(info.hexId)?.owner)
        .sort();
      expect(owners).toStrictEqual([alice.publicKey, bob.publicKey].sort());
    });

    test("should not complete split if amount is not a number", () => {
      const wallet = getWallet();
      pushToIdfsTree(wallet);
      const walletHexid = getHashFromData(wallet);
      const rootHexid = getRootHexid();

      const { completedActions } = runActions({
        actions: {
          [alice.publicKey]: split({
            wallet: walletHexid,
            receiver: bob.publicKey,
            amount: "abc",
            data: "",
          }),
        },
        initialRouterHexID: rootHexid,
      });

      expect(completedActions).toStrictEqual([]);
      expect(getRootHexid()).toBe(rootHexid);
      expect(verifyElementInIDFS(walletHexid)).toBe(VerificationStatus.FOUND);
    });

    test("should skip malformed actions and keep the tree", () => {
      const wallet = getWallet();
      pushToIdfsTree(wallet);
      const walletHexid = getHashFromData(wallet);
      const rootHexid = getRootHexid();

      const malformedActions: Action[] = [
        split({ wallet: walletHexid, receiver: bob.publicKey, amount: "1" }),
        split(null),
        { from: alice.publicKey, type: "merge", ttr: BLOCK_NUMBER + 1, data: null },
        { from: alice.publicKey, type: "mint", ttr: BLOCK_NUMBER + 1, data: null },
      ];

      malformedActions.forEach((action) => {
        const { completedActions } = runActions({
          actions: { [alice.publicKey]: action },
          initialRouterHexID: rootHexid,
        });
        expect(completedActions).toStrictEqual([]);
        expect(getRootHexid()).toBe(rootHexid);
      });
    });
  });

  describe("encryption", () => {
    beforeAll(async () => {
      await libsodium.ready;
    });

    test("should decrypt message from the sender", () => {
      changeKeys(alice);
      const encrypted = encryptFor(bob.publicKey, "hello bob");

      changeKeys(bob);
      expect(decryptFrom(alice.publicKey, encrypted)).toBe("hello bob");
    });

    test("should encrypt the same message differently every time", () => {
      expect(encryptFor(bob.publicKey, "hello bob")).not.toBe(
        encryptFor(bob.publicKey, "hello bob")
      );
    });
  });

  describe("saveToDB", () => {
    test("should not start an endless timer for every save", () => {
      const setIntervalSpy = jest.spyOn(global, "setInterval");
      for (let i = 0; i < 10; i++) saveToDB(getWallet({ ttd: 2000 + i }));
      expect(setIntervalSpy).toBeCalledTimes(0);
      setIntervalSpy.mockRestore();
    });
  });
});
