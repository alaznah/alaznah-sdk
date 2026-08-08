# Alaznah SDK

**Package:** `@alaznah/calling`  
**Repo:** [alaznah/alaznah-sdk](https://github.com/alaznah/alaznah-sdk)  
**Status:** Public · Beta  
**Platform:** React Native (iOS & Android)

Add **1:1 voice and video calling** to your mobile app with Alaznah Cloud — provider, hooks, and ready-made call UI.

## Links

| Resource | URL |
| --- | --- |
| Docs | [docs.alaznah.com](https://docs.alaznah.com) |
| Console | [console.alaznah.com](https://console.alaznah.com) |
| Signaling | `wss://signal.alaznah.com` |
| Protocol | [alaznah/alaznah-protocol](https://github.com/alaznah/alaznah-protocol) |
| Signaling server (private) | [alaznah/alaznah-signaling](https://github.com/alaznah/alaznah-signaling) |
| Examples | [alaznah/alaznah-examples](https://github.com/alaznah/alaznah-examples) |
| Docs site (private) | [alaznah/alaznah-docs](https://github.com/alaznah/alaznah-docs) |

## Requirements

- React Native CLI app, or Expo **development build** (Expo Go is not supported)
- Peer dependencies declared in this package’s `package.json` (install what your package manager reports)
- Short-lived calling tokens from **your** backend (never ship secrets in the app)

## Install

```bash
npm install @alaznah/calling
# resolve any peer dependency prompts from your package manager
cd ios && pod install && cd ..
```

Full steps: [Installation](https://docs.alaznah.com/docs/installation).

## Quickstart

```tsx
import { Button } from 'react-native';
import { CallingProvider, useCallingClient, useCallingReady } from '@alaznah/calling';
import { CallingUI } from '@alaznah/calling/ui';

async function fetchCallingToken(): Promise<string> {
  const res = await fetch('https://your-api.example.com/calling/token');
  const { token } = await res.json();
  return token;
}

function Dialer() {
  const client = useCallingClient();
  const ready = useCallingReady();
  return (
    <>
      <Button
        disabled={!ready}
        title="Call"
        onPress={() => void client.startCall({ calleeId: 'bob', mediaType: 'video' })}
      />
      <CallingUI client={client} />
    </>
  );
}

export function App() {
  return (
    <CallingProvider
      config={{
        signalingUrl: 'wss://signal.alaznah.com',
        userId: 'alice',
        getAuthToken: fetchCallingToken,
      }}
    >
      <Dialer />
    </CallingProvider>
  );
}
```

More: [Quick start](https://docs.alaznah.com/docs/quick-start).

## Alaznah Cloud

| Service   | Endpoint                                           |
| --------- | -------------------------------------------------- |
| Signaling | `wss://signal.alaznah.com`                         |
| Health    | `https://signal.alaznah.com/health`                |
| Docs      | [docs.alaznah.com](https://docs.alaznah.com)       |
| Console   | [console.alaznah.com](https://console.alaznah.com) |

Self-hosting: point `signalingUrl` at your own `wss://` endpoint. Server source for operators: [alaznah/alaznah-signaling](https://github.com/alaznah/alaznah-signaling) (private). Operator guides are also in the product docs under **Platform**.

## Mobile checklist

- Camera / microphone permissions (and usage strings on iOS)
- Push wake for background / killed-state calls (configure credentials in the Console; register tokens from the app — see docs)
- Physical devices recommended for end-to-end call tests

## Beta notes

- 1:1 calls in this release (group calling on the roadmap)
- Reliable connectivity on restricted networks may require relay settings from your Alaznah project
- Public APIs can still change before `1.0.0`

## Develop in this repo

```bash
npm install
npm run build
npm test
npm run pack:check
```

## License

MIT — see `LICENSE`.
