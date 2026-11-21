# Roadmap

Open tickets after the November 2026 code audit and external review. Each ticket says what is
wrong, where it is and what "done" looks like.

Priority:

- **P0** - the network can be cheated or split. Fix before any public launch.
- **P1** - security or reliability problem with a known workaround or a limited effect.
- **P2** - quality, tooling and maintenance.

Tickets that change the wire format or the consensus rules are marked **breaking**: all nodes
must update together. Plan them into one release (see R-04).

## P0 - consensus

### R-01. Count cold votes only for validated roots (breaking)

A cold message carries both the root router and the wallet proof. The proof shows that the wallet
is in that tree, not that the tree is the result of a valid block. A peer can invent a state, put
a rich wallet into it and vote for it; `addNewColdMessage` can then switch the node to that state.
Only the 10e12 bonus of the support nodes hides the problem today.

- Where: `frontend/src/network/consensus/consensus.tsx` (`addNewColdMessage`).
- Done: a node counts a vote only for a final root it has validated in this round (the final root
  of a block it accepted). A new node gets its first state through a separate, explicit path
  (for example: a state signed by support nodes). Test: a vote for an invented root is ignored.

### R-02. Blocks must name the exact actions they include (breaking)

`block.data.actions` is a list of author ids. If one key signs two different actions for the same
block number, each node keeps whichever arrived first. A block then means different things to
different nodes, they compute different final roots and reject each other's blocks.

- Where: `consensus.tsx` (`addNewAction`, `startWarmupStage`, `addNewBlock`), `consensus/utils.tsx`
  (`measureBlock`), `interfaces.tsx`.
- Done: a block lists action digests; a node that lacks an action can request it from the block
  sender. Test: two actions from one author for one block do not split two nodes.

### R-03. Replace the MD5 content hash (breaking)

`getHashFromData` is MD5 over a JavaScript string read as raw bytes. MD5 collisions are practical,
and strings with non-latin symbols collide even without them (see the test "should not verify
different data with the same legacy hash"). Every id in the state tree is this hash, and the
transport signature (`signMessage` / `verifyMessage`, duplicated in the gate) signs it too.
Signatures of actions and blocks already use SHA-256 of UTF-8 bytes.

- Where: `frontend/src/network/crypto/crypto.tsx`, `server/app/index.ts`, hard-coded
  `ed46ffc743e80ff8474280f719ccdc8e` (the empty root) in `consensus.tsx` and `consensus/utils.tsx`.
- Done: one hash function, SHA-256 of UTF-8 bytes, for element ids and transport signatures; the
  empty root id is computed, not hard-coded; the IndexedDB name is bumped.

### R-04. Isolate incompatible protocol versions (breaking)

Nodes do not tell each other which protocol they speak. A tab that was opened before an update
keeps sending messages that updated nodes silently drop, while old nodes still accept them, so the
two groups drift to different states on the same gate.

- Where: `consensus/constants.tsx` (`APP_VERSION`), `socket.tsx` (LOGIN), `network.tsx`,
  `server/app/index.ts`.
- Done: a protocol version is sent in LOGIN and in the first WebRTC message; the gate lists only
  peers of the same version; a node closes a channel with another version and tells the user to
  reload.

### R-05. Choose consensus rules by network id, not by build mode

`runActions` lets anybody mint when `NODE_ENV` is `development`. A development build pointed at a
production gate (`REACT_APP_GATE_URL`) applies different rules to the same signed action than its
peers.

- Where: `consensus/runActions.tsx` (mint), `webrtc.tsx` (heartbeat), `network.tsx`
  (`updateConnections`).
- Done: a network id (for example `main` / `dev`) is part of the protocol version from R-04 and
  selects the rules; `NODE_ENV` no longer changes consensus behaviour.

## P1 - security

### R-06. Give out TURN credentials only to logged-in peers

The gate asks Twilio for credentials on every socket connection, before LOGIN and outside the rate
limiter. Anybody can open sockets and use the relay traffic this deployment pays for.

- Where: `server/app/index.ts` (`getIceConfig` call in the connection handler).
- Done: credentials are created after a valid LOGIN, at most once per key per period, with a short
  TTL; connections per IP are limited.

### R-07. Validate receiver keys and amounts strictly (breaking)

`split` and `mint` accept any string as the owner, so a typo burns the tokens. Amounts go through
`parseInt`, so `"12junk"` is 12 and values above 2^53 lose precision.

- Where: `consensus/runActions.tsx`.
- Done: the owner must match `^[0-9a-f]{64}$`; an amount must be a whole string of digits and a
  safe integer; derived `ttd` values are checked to be safe integers. The check must not depend on
  libsodium being loaded, or nodes will disagree.

### R-08. Limit what a peer can store on a node

Any connected peer can send `IDFS` messages, and the node saves every element to memory and
IndexedDB without checking its shape, size or relevance. The `cache` object in memory is never
trimmed.

- Where: `webrtc.tsx` (IDFS branch of `onmessage`), `idfs/idfsDB.tsx` (`saveToDB`, `cache`),
  `network.tsx` (ACTION attachments).
- Done: an element is validated (router or state element, size limit from `settings.tsx`), a peer
  has a storage quota per step, unverified elements expire.

### R-09. SMS: version the format and stop replays

`decryptFrom` throws on anything that is not the current `nonce + ciphertext` format, and the
handlers do not catch it. Both dedup lists forget a message after 10 000 newer ones, so an old
signed SMS can be delivered again. `ReceivedSMSMessagesWidget` tries to decrypt every SMS that
passes through the node, including the ones for other peers.

- Where: `crypto/crypto.tsx`, `network.tsx` (`onNewSmsMessage`), `webrtc.tsx`,
  `frontend/src/dashboard/widgets/ReceivedSMSMessagesWidget.tsx`.
- Done: the ciphertext starts with a format byte; a failed decrypt is logged, not thrown; a
  receiver drops an SMS older than a fixed window or with an already seen per-sender counter; the
  widget shows only messages addressed to this node.

### R-10. One key in two tabs

Two tabs of the same browser share the key from `localStorage`, so they are two nodes with one id.
The gate and the peers keep one connection per id, and the tabs overwrite each other.

- Where: `frontend/src/network/index.tsx` (`initPrfctNode`), `server/app/index.ts` (`connections`).
- Done: a second tab detects the first one (BroadcastChannel or Web Locks) and either stays passive
  or asks the user; the behaviour is described in the README.

### R-11. Tie ICE candidates to a negotiation

Candidates are matched to a connection by peer id only. During a reconnect a candidate of the new
attempt can be applied to the old connection and lost.

- Where: `frontend/src/network/webrtc.tsx`.
- Done: invite, response and candidates carry a negotiation id; a candidate is applied or queued
  only for its own negotiation; queues of abandoned negotiations expire by time.

## P1 - reliability

### R-12. Do not drive the engine with requestAnimationFrame

`Stream.emit` and the logger deliver every event through `requestAnimationFrame`. A browser stops
these callbacks in a background tab, so a node stops handling blocks, actions and messages as soon
as the user switches tabs.

- Where: `EventEmitter/EventEmitter.ts`, `logger/logger.tsx`, `idfs/IDFS.tsx` (init).
- Done: network events are delivered by a mechanism that works in background tabs (for example a
  Web Worker for the engine, or `MessageChannel`); only widgets use animation frames. Test: two
  nodes keep one state while one tab is hidden.

### R-13. Load the state from IndexedDB on start

`ressurectFromIndexedDB` is commented out, so after a reload the node starts from the empty root
and waits for the network to hand it the state again. A network where all tabs were closed loses
its state.

- Where: `idfs/idfsDB.tsx`, `idfs/IDFS.tsx` (`startElementsLoop`).
- Done: the last accepted root is stored and restored on start together with its routers and
  elements; `lostInIDFS` is implemented or removed with its tests.

### R-14. Explicit keep-alive

`MessageType` has `PING`, but nothing sends it. A connection stays alive only because blocks flow
every step; a quiet connection is destroyed after two steps.

- Where: `webrtc.tsx` (`heartbeat`), `network.tsx`.
- Done: peers exchange PING on a timer and the heartbeat counts it, or the `PING` type is removed.

### R-15. Clock skew

The block number is `Date.now()` divided by the step length. Nodes whose clocks differ by a few
seconds are in different stages and drop each other's blocks and votes.

- Where: `consensus/consensus.tsx` (`startWarmupStage`, `initLoop`).
- Done: a node estimates its offset from the peers (or the gate) and uses the corrected time; the
  dashboard warns when the offset is large.

### R-16. Bring the gate back

`https://prfct.ee` does not answer, and it is the default gate of a production build.

- Done: the gate is deployed again or the default is changed; the README says where the public
  gate is and how to run a private one.

## P2 - quality and tooling

### R-17. Repair the old unit tests

20 tests in `frontend/src/network/tests` fail. They describe an older tree (4 elements per router,
now 3), an implemented `lostInIDFS` and old mocks of `runActions`.

- Done: every test is either updated to the current behaviour after checking that the behaviour is
  intended, or deleted with a reason; `npm test` is green.

### R-18. Docker build

The images use `node:14-alpine`, which is past its end of life. The frontend image runs `npm i`
without the lock file, so builds are not repeatable. The Docker build was not run during the audit.
`version` in `docker-compose.yml` is obsolete.

- Where: `Dockerfile`, `server/Dockerfile`, `docker-compose.yml`.
- Done: a supported Node version, `npm ci` with the lock files, a verified
  `REACT_APP_GATE_URL=http://localhost npm run restart`.

### R-19. Gate server project setup

The gate has no `tsconfig.json`, no `typescript` or `pm2` in `package.json` and no tests. Its
crypto and interfaces are copies of the frontend code and already differ (`ttr` vs `datestamp`).

- Where: `server/`.
- Done: the gate builds and starts with `npm ci && npm start` outside Docker; message types and
  signature checks come from one shared module; tests cover LOGIN, relay and rate limit.

### R-20. Continuous integration

Nothing checks a change automatically.

- Done: a workflow runs type check, `npm test` for the engine, the frontend build and the gate
  build on every pull request.

### R-21. Lint warnings and small bugs

- `==` / `!=` in the engine, unused imports and variables (`npm run build` lists them).
- `MyPrfctWalletsSplit` and `MyPrfctWalletsMerge` use `useCallback(..., [])` and can act on a stale
  wallet id.
- `server/.DS_Store` is committed.
- `Stream` is implemented twice (`EventEmitter/EventEmitter.ts` and `logger/logger.tsx`).

### R-22. Finish or remove the block reward

The reward code in `runActions` is commented out, and the `authorWallet` argument is unused.

- Where: `consensus/runActions.tsx`.
- Done: a decision on the reward model; the code is either finished with tests or deleted.
