# Prfct Network

Browser Native Blockchain Network

## Description

Prfct Network is a next-generation blockchain platform that leverages the power of user browsers to create a highly accessible, secure, and efficient network. It uses TypeScript as the underlying programming language and WebRTC for peer-to-peer connections.

## Key Features

- Browser-native blockchain
- Lightweight and efficient
- Decentralized file storage system
- Unique protocol for sending encrypted instant messages
- Visual programming language for smart contracts (in development)

For more detailed information, please refer to our [Medium article](https://medium.com/@mikhaildunaev/problems-a829b863e801).

## Technologies Used

- TypeScript
- React
- WebRTC
- Socket.IO

## Running locally

The whole network (gate server + site) in Docker. The site is a production build, so tell it to
use the local gate instead of `https://prfct.ee`:

```
REACT_APP_GATE_URL=http://localhost npm run restart
```

Or by hand: start the gate (`server/`, socket.io on port 8070), then the site:

```
cd frontend
npm install
REACT_APP_GATE_URL=http://localhost:8070 npm start
```

Open `http://localhost:3000/?dashboard=1&fresh=1` in two visible windows. A node works only
while its tab is visible: the engine is driven by `requestAnimationFrame`.

Settings:

- `REACT_APP_GATE_URL` (site, build time) - address of the gate. Default: `https://prfct.ee`.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (gate) - Twilio STUN/TURN servers for WebRTC.
  Without them the gate hands out a public STUN server.

Tests of the network engine:

```
cd frontend/src/network
npm test
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Contact

Join our [Discord](https://discord.gg/t3cDSRjuEB) to receive free test tokens and stay updated.
