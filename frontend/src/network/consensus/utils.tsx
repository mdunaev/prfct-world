import { Action, BlockActions, BlockData, StateElementWithPath } from "../interfaces";
import { actionBonus, stepSize, supportNodes } from "./constants";
import { getHashFromData, getHexPosition } from "../crypto/crypto";
import { getRootHexid, setRootHexid, StateElement } from "../idfs/IDFS";
import { runActions } from "./runActions";
import { getActions, state } from "./consensus";
import { saveToDB } from "../idfs/idfsDB";

const countDistanceScores = (block: BlockData) => {
  const isSupportNode = supportNodes.includes(block.author);
  return getHexPosition(getHashFromData(block)) / 10e6 + (isSupportNode ? 10e12 : 0);
};

const countActionScores = (completedActionsCount: number) => completedActionsCount * actionBonus;

export const countWalletScores = (wallet: StateElement | undefined) => wallet?.ttd || 1;

const countBlockScores = (block: BlockData, completedActionsCount: number) => {
  const scores =
    countDistanceScores(block) +
    countActionScores(completedActionsCount) +
    countWalletScores(block.wallet?.element);

  const bonusMultiplier =
    block.final != "ed46ffc743e80ff8474280f719ccdc8e" && supportNodes.includes(block.author)
      ? 1000
      : 0;

  return scores + scores * bonusMultiplier;
};

export const measureBlock = (block: BlockData, skipCheck = false): number => {
  const initialRouterHexID = getRootHexid();

  if (skipCheck) {
    return countBlockScores(block, block.actions.length);
  }

  if (block.initial !== initialRouterHexID) {
    console.log("block.initial !== initialRouterHexID");
    return -1;
  }

  const actions = getActions();
  const thisStepActions: BlockActions = actions[block.block] || {};
  if (!block.actions.every((hexId) => thisStepActions[hexId])) {
    console.log("!block.actions.every((hexId) => thisStepActions[hexId])");
    return -1;
  }

  const fromBlockActions = block.actions.reduce((result, hexId) => {
    result[hexId] = thisStepActions[hexId];
    return result;
  }, {} as BlockActions);

  const { completedActions } = runActions({
    actions: fromBlockActions,
    initialRouterHexID: block.initial,
    authorWallet: block.wallet?.element,
  });
  const finalRouterHexID = getRootHexid();
  setRootHexid(initialRouterHexID);

  if (block.final !== finalRouterHexID) {
    console.log("block.final !== finalRouterHexID");
    return -1;
  }

  return countBlockScores(block, completedActions.length);
};

export const ttdToTimePoints = (ttd: number, size: number | undefined, blockNumber: number) =>
  Math.floor((ttd - blockNumber) / Math.ceil((size || stepSize) / stepSize));

export const timePointsToTDD = (tpoints: number, size: number | undefined, blockNumber: number) =>
  Math.floor(blockNumber + tpoints / Math.ceil((size || stepSize) / stepSize));

export const saveWalletFromBlock = (wallet?: StateElementWithPath) => {
  if (!wallet || !wallet.element) {
    return;
  }

  wallet.path.map((router) => saveToDB(router));
  saveToDB(wallet.element);
};

//_ Verify that the wallet is a part of the state with the given root router.
//_ The path is a proof: a chain of routers from the root down to the router that holds the wallet.
//_ Every link is checked by hash, so the check does not depend on what is in the local DB.
export const isWalletVerified = (wallet: StateElementWithPath | undefined, rootHexid: string) => {
  const element = wallet?.element;
  const path = wallet?.path;

  if (!element || !Array.isArray(path) || path.length === 0) return false;

  try {
    if (getHashFromData(path[0]) !== rootHexid) return false;

    for (let i = 0; i < path.length - 1; i++) {
      const nextRouterHexid = getHashFromData(path[i + 1]);
      const routers = Object.values(path[i]?.routers || {});
      if (!routers.includes(nextRouterHexid)) return false;
    }

    const elementHexid = getHashFromData(element);
    const lastRouter = path[path.length - 1];
    const elementInfo = lastRouter.stateElements.find((info) => info?.hexId === elementHexid);

    return !!elementInfo && element.ttd >= state.blockNumber;
  } catch (error) {
    // the proof comes from another peer and can have any shape
    return false;
  }
};

//_ The part of the action that its author signs
export const getActionPayload = ({ from, type, ttr, data }: Action) => ({ from, type, ttr, data });
