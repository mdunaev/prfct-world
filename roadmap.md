# Roadmap

Open tickets after the November 2026 code audit and two external reviews. Each ticket says what is
wrong, where it is and what "done" looks like.

Priority:

- **P0** - tokens can be lost, or the network can be cheated or split. Fix before any public
  launch.
- **P1** - security or reliability problem with a known workaround or a limited effect.
- **P2** - quality, tooling and maintenance.

Tickets that change the wire format or the consensus rules are marked **breaking**: all nodes
must update together. The last section gives the order to release them in.

## P0 - ledger

These three were reproduced with tests during the audit. They lose tokens in normal use, without
any attacker.

### R-23. Deleting a wallet can detach other wallets (breaking)

`deleteInIDFSRecursion` unlinks a child router as soon as its own `stateElements` list is empty.
It does not look at the child's `routers`. If that router still has routers below it, every wallet
under them disappears from the new root. Reproduced: in a tree of 60 wallets, deleting the elements
of one inner router made 17 other live wallets unreachable. Every split and merge deletes wallets.

- Where: `frontend/src/network/idfs/IDFS.tsx` (`deleteInIDFSRecursion`).
- Done: a router is unlinked only when it has no elements and no routers. Test: delete the last
  element of an inner router that has children, then verify every other wallet against the new
  root.

### R-24. Two equal payments to one receiver become one wallet (breaking)

The receiver wallet of a split gets `lookupKey = hash(action.data.hexid + ttr + data)`, but a
split has no `hexid` field, and the source wallet and the `nonce` are not used. Two senders who
pay the same amount with the same data to one receiver in one block create identical wallets. The
tree treats the second insert as a success and keeps one. Reproduced: both senders are debited,
the receiver gets one wallet.

- Where: `consensus/runActions.tsx` (split, also mint), `idfs/IDFS.tsx` (`pushToRouter`, the
  "already exists" branch).
- Done: the id of an output wallet includes the action author and the source wallet (or the
  signed action digest from R-02). Inserting an element that already exists is an error for
  `runActions`, not a success. Test: two equal payments give the receiver two spendable wallets.

### R-25. Wallets with data lose balance on every split and merge (breaking)

`ttdToTimePoints` divides by the size factor `ceil(size / 64)`, and `timePointsToTDD` divides by it
again. For a wallet with 65-128 symbols of data, 100 steps become 50 time points and then 25 steps.
Split applies this to the sender's change, merge to the combined balance. Wallets with empty data
(factor 1) are not affected, which is why the dashboard looks correct.

- Where: `consensus/utils.tsx` (`ttdToTimePoints`, `timePointsToTDD`), `consensus/runActions.tsx`.
- Done: the storage-cost rule is written down; converting steps to time points and back returns
  the same value up to the stated rounding. Test: split and merge conserve the total, minus the
  explicit 1% fee, for data sizes 0, 64, 65 and 1200.

## P0 - consensus

### R-01. Count cold votes only for validated roots (breaking)

A cold message carries both the root router and the wallet proof. The proof shows that the wallet
is in that tree, not that the tree is the result of a valid block. A peer can invent a state, put
a rich wallet into it and vote for it; `addNewColdMessage` can then switch the node to that state.
Only the 10e12 bonus of the support nodes hides the problem today.

The vote itself is also not well defined. A node's own vote names the author of its best block,
while a received vote is counted under the key that signed the transport message, so two honest
nodes tally the same vote under different names. A vote has no round number, and a relayed vote is
signed again by the relay.

- Where: `consensus/consensus.tsx` (`startCooldownStage`, `addNewColdMessage`), `network.tsx`
  (COLD_MESSAGE handler), `interfaces.tsx` (`ColdMessage`).
- Done:
  - a vote is `{ voter, round, root }` signed by the voter and relayed unchanged;
  - a node counts a vote only for a root it has validated in this round;
  - a node that is behind (new, returned from sleep, or missed one round) has an explicit way to
    catch up: it fetches the missing blocks and replays them, or it accepts a checkpoint signed by
    a stated number of support nodes for a stated network and round. Without this rule a node that
    misses one round can never rejoin.
  - Tests: a vote for an invented root is ignored; two nodes converge again after one of them
    misses a block that changed the state.

### R-02. Blocks must name the exact actions they include (breaking)

`block.data.actions` is a list of author ids. If one key signs two different actions for the same
block number, each node keeps whichever arrived first. A block then means different things to
different nodes, they compute different final roots and reject each other's blocks.

- Where: `consensus.tsx` (`addNewAction`, `startWarmupStage`, `addNewBlock`), `consensus/utils.tsx`
  (`measureBlock`), `consensus/runActions.tsx`, `interfaces.tsx`.
- Done: a block lists action digests. Still one action per author per block, and the author comes
  from the verified signature (mint authorization depends on it). A node that lacks a listed action
  can fetch it by digest; this path is separate from `addNewAction`, which rejects actions for the
  current block. Test: with two actions from one author for one block, two nodes accept the same
  block and reach the same root.

### R-26. Equal scores must have one winner (breaking)

`addNewBlock` replaces the best block only when the new score is strictly greater, and the cold
tally sorts by weight only. With equal scores the winner is whichever arrived first, so two nodes
can see the same candidates and choose different ones. The block score is also a hash of the block
as it was sent, while execution sorts actions by author: the same set of actions in another order
gives another score.

- Where: `consensus/consensus.tsx` (`addNewBlock`, `addNewColdMessage`), `consensus/utils.tsx`
  (`countDistanceScores`).
- Done: a block has one canonical form (actions sorted, fixed field order) and other forms are
  rejected; ties are broken by a fixed rule (for example the lower hash) in both stages. Test: the
  same candidates in any order give the same winner.

### R-27. Define who may vote and with what weight (breaking)

`countWalletScores` returns the wallet's `ttd`, which is an absolute block number (about 30
million today) plus the balance. So almost every wallet has the same weight, and a wallet that
expires this round still votes at full weight. A key without a wallet gets weight 1. The node picks
its own voting wallet with `createdAt < blockNumber`, but a received proof is accepted without the
age check and without checking that the element is a wallet.

- Where: `consensus/utils.tsx` (`countWalletScores`, `countBlockScores`, `isWalletVerified`),
  `idfs/myWallets.tsx` (`getMyBestWallet`).
- Done: weight is the remaining balance (`ttd - blockNumber`, in time points); the same
  eligibility rule (type, age, not expired) is used for the local choice and for received proofs;
  the weight of a walletless vote is stated. Tests for each rule.

### R-03. Replace the MD5 content hash (breaking)

`getHashFromData` is MD5 over a JavaScript string read as raw bytes. MD5 collisions are practical,
and strings with non-latin symbols collide even without them (see the test "should not verify
different data with the same legacy hash"). Every id in the state tree is this hash, and the
transport signature (`signMessage` / `verifyMessage`, duplicated in the gate) signs it too.
Signatures of actions and blocks already use SHA-256 of UTF-8 bytes.

- Where: `frontend/src/network/crypto/crypto.tsx`, `server/app/index.ts`, hard-coded
  `ed46ffc743e80ff8474280f719ccdc8e` (the empty root) in `consensus.tsx` and `consensus/utils.tsx`.
- Done:
  - one hash, SHA-256 of UTF-8 bytes, for element ids and transport signatures;
  - the empty root is a constant with fixed bytes per network. Do not compute it at start: the
    empty router contains `createdAt: state.blockNumber`, so its hash depends on the moment
    `initRootRouter` runs;
  - a decision on old state: a verified migration or a new genesis. Routers store child and wallet
    hashes, so every id changes. The IndexedDB name is bumped;
  - the browser and the gate pass the same hash and signature test vectors (see R-19).

### R-04. Isolate incompatible protocol versions (breaking)

Nodes do not tell each other which protocol they speak. A tab that was opened before an update
keeps sending messages that updated nodes silently drop, while old nodes still accept them, so the
two groups drift to different states on the same gate.

- Where: `consensus/constants.tsx` (`APP_VERSION`), `socket.tsx` (LOGIN), `network.tsx`,
  `webrtc.tsx`, `server/app/index.ts`.
- Done: a protocol version is sent in LOGIN and in a handshake that is the first message on a data
  channel. No other message (IDFS, SMS, blocks) is processed before a successful handshake, and a
  peer that sends none is disconnected after a timeout. The gate lists and relays only between
  peers of the same version. A node with an old version tells the user to reload.

### R-05. Choose consensus rules by network id, not by build mode (breaking)

`runActions` lets anybody mint when `NODE_ENV` is `development`. A development build pointed at a
production gate (`REACT_APP_GATE_URL`) applies different rules to the same signed action than its
peers.

- Where: `consensus/runActions.tsx` (mint), `consensus/utils.tsx` (`getActionPayload`),
  `interfaces.tsx` (`BlockData`). The `NODE_ENV` checks in `webrtc.tsx` (heartbeat) and
  `network.tsx` (`updateConnections`) only change transport behaviour and can stay.
- Done: a network id (for example `main` / `dev`) selects the rules. It is part of the handshake
  from R-04 and of the signed bytes of actions, blocks and votes, so a signed action can not be
  replayed on another network.

## P1 - security

### R-30. Bind a gate socket to one key

LOGIN is accepted without a challenge, so a recorded LOGIN message works again later. One socket
can log in under several keys; on disconnect only the last one is removed and the others stay in
the peer list forever. Signaling is relayed for any validly signed message, even from a socket that
never logged in.

- Where: `server/app/index.ts`.
- Done: the gate sends a random challenge on connect and LOGIN signs it; a socket has at most one
  key; relay requires a logged-in socket whose key equals `raw.from`. Tests in the gate (R-19).

### R-06. Give out TURN credentials only to logged-in peers

Depends on R-30. When Twilio keys are set, the gate asks Twilio for credentials on every socket
connection, before LOGIN and outside the rate limiter. Anybody can open sockets and use the relay
traffic this deployment pays for. Without Twilio keys the gate hands out a public STUN server and
nothing is billed.

- Where: `server/app/index.ts` (`getIceConfig` call in the connection handler), `webrtc.tsx`
  (`createConnetion` uses whatever configuration has arrived).
- Done: credentials are created after LOGIN; limits are numbers in the config (per key, per IP and
  for the whole deployment per hour) with a stated TTL; a node does not start a connection before
  it has the ICE configuration.

### R-29. Validate STATUS before using it

A peer's STATUS payload is stored in `peersChildren` as is. `updateConnections`, `sendMessage` and
`isNeighborByHexDistance` then treat it as a list of ids. A payload that is not a list of strings
throws inside `updateConnections` before it schedules its next run, and the node stops looking for
peers until the page is reloaded.

- Where: `network.tsx` (`updateClientPeersReducer`, `updateConnections`),
  `idfs/isNeighborByHexDistance.tsx`.
- Done: STATUS is accepted only as an array of at most N hex ids; `updateConnections` schedules its
  next run in `finally`. Test: a malformed STATUS does not stop discovery.

### R-07. Validate receiver keys and amounts strictly (breaking)

`split` and `mint` accept any string as the owner, so a malformed key burns the tokens. Amounts go
through `parseInt`, so `"12junk"` is 12 and values above 2^53 lose precision.

- Where: `consensus/runActions.tsx`; producers: `dashboard/widgets/WalletManagementWidget.tsx`,
  `MyPrfctWalletsWidget/*`, `RandomActionGeneratorWidget.tsx` (sends amounts as numbers).
- Done: the owner must match `^[0-9a-f]{64}$`; an amount must be a string of digits and a safe
  integer; intermediate and resulting `ttd` values are checked too. All producers send the new
  format in the same release. The check must not depend on libsodium being loaded, or nodes will
  disagree. This does not catch a well-formed key with a typo; the UI should ask to confirm the
  receiver.

### R-08. Limit what a peer can store on a node

Any connected peer can send `IDFS` messages, and the node saves every element to memory and
IndexedDB without checking its shape or size. Elements are removed only when the scanner finds
them `NOT_FOUND` in the current tree; `LOST` elements and everything received while the node is on
the empty root stay.

- Where: `webrtc.tsx` (IDFS branch of `onmessage`), `idfs/idfsDB.tsx` (`saveToDB`, `cache`),
  `idfs/IDFS.tsx` (`elementsLoop`), `network.tsx` (ACTION attachments).
- Done: separate, stated limits for a wire message and for a consensus element (today 1200 is only
  the length of split data; mint has no limit); a total storage bound with eviction that never
  removes elements of the committed state (R-13); a way to fetch a missing verified element again.

### R-09. SMS: version the format and stop replays (breaking)

`decryptFrom` throws on anything that is not the current `nonce + ciphertext` format, and the
handlers do not catch it. Both dedup lists forget a message after 10 000 newer ones, so an old
signed SMS can be delivered again. `ReceivedSMSMessagesWidget` subscribes to the raw stream and
tries to decrypt every `SMS_TEXT` that passes through the node, before the engine checks the
receiver.

- Where: `crypto/crypto.tsx`, `network.tsx` (`onNewSmsMessage`), `webrtc.tsx`,
  `frontend/src/dashboard/widgets/ReceivedSMSMessagesWidget.tsx`.
- Done: the ciphertext starts with a format byte; a failed decrypt is logged, not thrown; the
  widget reads the accepted stream (`onSMSforAccount`); replay protection has a stated window for
  late and out-of-order messages and survives a reload. Per-sender counters need R-10 first.

### R-10. One key in two tabs

Two tabs of the same browser share the key from `localStorage`, so they are two nodes with one id.
The gate and the peers keep one connection per id (the gate keeps the latest login), and both tabs
sign blocks and actions.

- Where: `frontend/src/network/index.tsx` (`initPrfctNode`), module-level start code in
  `idfs/IDFS.tsx` and `idfs/idfsDB.tsx`, `server/app/index.ts`.
- Done: at most one tab signs for a key (Web Locks); other tabs show a notice and run no engine
  code, including the IDFS start and database scans; a waiting tab takes over when the owner
  closes; tabs opened with `?fresh=1` are independent. Test: two tabs started at the same moment.

### R-11. Tie WebRTC callbacks and candidates to one connection

Connections are found by peer id only. `destroy(hexid)` is called from the `onclose` and `onerror`
of a data channel, and it destroys whatever connection is current for that peer. When a connection
is replaced, the late `onclose` of the old channel destroys the new connection. For the same
reason a candidate of a new attempt can be applied to the old connection and lost.

- Where: `frontend/src/network/webrtc.tsx` (`addDataChannel`, `destroy`, `createConnetion`,
  candidate handling).
- Done: callbacks hold their own connection and act only if it is still the current one; invite,
  response and candidates carry a negotiation id (a wire change, release with R-04); queues of
  abandoned negotiations expire by time. Test: a late close of a replaced channel does not touch
  the new connection.

## P1 - reliability

### R-28. Validating a block must not change anything

`addNewBlock` runs the actions of a candidate block before `measureBlock` checks that the block
starts from the node's root, and `measureBlock` runs them again. `runActions` ignores its
`initialRouterHexID` argument and starts from the global root. A trial run writes elements to
IndexedDB and, for a split, sends wallets to peers (`setElementToVipList`). Restoring the root
afterwards does not undo that, even for a rejected block.

- Where: `consensus/consensus.tsx` (`addNewBlock`), `consensus/utils.tsx` (`measureBlock`),
  `consensus/runActions.tsx`, `network.tsx` (`sendAction` preview).
- Done: cheap checks first (round, parent, signature), then one run on a copy of the state;
  writes and sends happen only for the block that is committed. `runActions` uses the root it is
  given.

### R-13. Keep the committed state across reloads

`ressurectFromIndexedDB` is commented out, so after a reload the node starts from the empty root
and waits for peers to hand it the state. The elements stay in IndexedDB, but nothing records
which root was committed. If every tab is closed, the network has no node that knows the state.
Raise this to P0 if the chain must survive that.

- Where: `idfs/idfsDB.tsx`, `idfs/IDFS.tsx` (`startElementsLoop`, `setRootHexid`).
- Done: the committed round and root are stored, with the write awaited, when a round ends - not on
  every `setRootHexid`, which also changes for trial runs. On start the node restores them before
  consensus and before the scanner deletes anything. Test: reload in the middle of a round.
  `lostInIDFS` is implemented or removed together with its tests.

### R-12. Do not drive the engine with requestAnimationFrame

`Stream.emit` and the logger deliver events through `requestAnimationFrame`, which a browser
pauses in a background tab. The stage timers and the direct handlers keep running, so a hidden
node goes on producing its own blocks but does not process the blocks, actions and votes of its
peers.

- Where: `EventEmitter/EventEmitter.ts`, `logger/logger.tsx`, `idfs/IDFS.tsx` (init).
- Done: engine events do not depend on animation frames (a Web Worker for the engine, or
  `MessageChannel`); only widgets use them. Test: one hidden tab and one visible tab apply a mint
  and a split and stay on one root while the block number advances. A browser can still freeze a
  tab completely; after a freeze the node catches up through R-01.

### R-14. Explicit keep-alive

`MessageType` has `PING`, but nothing sends it. The heartbeat counts STATUS, ACTION, BLOCK and
COLD_MESSAGE; SMS and IDFS do not count. A connection with no such traffic is destroyed after two
to four steps (never in a development build). The gate has its own one-minute timer for quiet
sockets.

- Where: `webrtc.tsx` (`heartbeat` and its timer), `network.tsx`, `server/app/index.ts`.
- Done: peers send PING on a timer and every received message counts. Test: two idle production
  nodes stay connected to each other and to the gate.

### R-15. Clock skew

The block number is `Date.now()` relative to a fixed epoch, and the stage timers are aligned to the
wall clock. Nodes whose clocks differ by a few seconds are in different stages and drop each
other's blocks and votes.

- Where: `consensus/consensus.tsx` (`initLoop`, `startWarmupStage`, `startCooldownStage`).
- Done: one corrected clock drives both the block number and the timers; the correction is
  estimated from several sources and has a limit, so one wrong source can not move a node to
  another round; the block number never goes back. Tests: both stage borders, sleep and wake, one
  wrong time source. The dashboard warns when the offset is large.

### R-16. Bring the gate back

`https://prfct.ee` is the default gate of a production build. It did not answer on 2026-11-21 (TLS
connection failed). The `nginx.conf` in the repository listens on port 80 only.

- Done: the gate is deployed again, with a named place where TLS ends, or the default is changed;
  the README says where the public gate is and how to run a private one. Check: two new browser
  identities log in, find each other and connect through the public address.

## P2 - quality and tooling

### R-17. Repair the old unit tests

20 tests in `frontend/src/network/tests` fail and one mint authorization test is skipped. They
describe an older tree (4 elements per router, now 3), an implemented `lostInIDFS`, old mocks of
`runActions` and old score values.

- Done: every test is either updated to the current behaviour after checking that the behaviour is
  intended, or deleted with a reason; the skipped test runs; `npm test` is green. The tests named
  in R-23, R-24, R-25 and R-01 are part of those tickets, not of this one.

### R-18. Docker build

The images use `node:14-alpine`, which is past its end of life. The frontend image runs `npm i`
without the lock files, `server/.dockerignore` excludes `package-lock.json`, and the gate image
installs `pm2@latest` and TypeScript globally, so builds are not repeatable. The Docker build was
not run during the audit. `version` in `docker-compose.yml` is obsolete.

- Where: `Dockerfile`, `server/Dockerfile`, `server/.dockerignore`, `docker-compose.yml`.
- Done: a supported Node version; `npm ci` with all three lock files; pinned gate tools (R-19); a
  clean build after which two browsers connect through the local gate. Note that `npm run restart`
  removes Docker volumes.

### R-19. Gate server project setup

The gate has no `tsconfig.json`, no build script, no `typescript` or `pm2` in `package.json` and
no tests. Its message types are copies of the frontend ones and already differ (`ttr` vs
`datestamp`; harmless today because the gate verifies the raw object and reads neither).

- Where: `server/`.
- Done: the gate builds and starts with `npm ci && npm start` outside Docker; message types and
  signature checks come from one shared module that is inside the gate's Docker build context;
  shared hash and signature test vectors run in the browser engine and in the gate; tests cover
  LOGIN, relay and rate limit. Do this before R-03 and R-04.

### R-20. Continuous integration

Nothing checks a change automatically.

- Done: a workflow runs, on every pull request, the frontend type check and build, `npm test` in
  `frontend/src/network`, and the gate build and tests. Start it before R-17 is finished, with the
  known failures listed, so new failures are visible.

### R-21. Lint warnings and small cleanups

- `==` / `!=` in the engine, unused imports and variables (`npm run build` lists them).
- `server/.DS_Store` is committed.
- `Stream` is implemented twice (`EventEmitter/EventEmitter.ts` with `unsubscribe`, and
  `logger/logger.tsx` without). Merge them after R-12 and keep `unsubscribe`.
- `MyPrfctWalletsSplit` and `MyPrfctWalletsMerge` use `useCallback(..., [])` with a prop inside.
  It works only because the parent sets `key={wallet.hexId}`.
- Done: `npm run build` prints no warnings for `src/network`; the items above are closed.

### R-22. Finish or remove the block reward

The reward code in `runActions` is commented out, and the `authorWallet` argument is unused. The
commented code reads `action.ttr` before `action` exists.

- Where: `consensus/runActions.tsx`.
- Done: a decision on the reward model. Removing the dead code is a cleanup. Turning rewards on is
  a **breaking** consensus change: the receiver and the amount must be fixed by the rules, replaying
  a block must give the same root, and only the committed block pays a reward (see R-28).

## Release order

1. **Safety net:** R-20 (CI with the known failures listed), R-19 (gate build, shared wire types
   and test vectors), then R-17.
2. **Fixes that do not change the protocol:** R-29, R-28, R-12, R-14, R-30, R-06, R-08, R-10.
3. **Version boundary:** R-04 together with R-05. Everything below ships behind a new protocol
   version, so old tabs are cut off instead of splitting the network.
4. **One breaking release:** the ledger fixes R-23, R-24, R-25; the hash and genesis R-03; then
   R-02, R-26, R-27, R-07; the vote rules and catch-up R-01 with R-13; the wire changes of R-09 and
   R-11.
5. **Operations:** R-16 and R-18 before a public launch; R-15 once more than a few nodes run.
