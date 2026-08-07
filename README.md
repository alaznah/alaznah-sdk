# Alaznah SDK

**Repository:** [Alaznah/alaznah-sdk](https://github.com/Alaznah/alaznah-sdk)  
**Package:** `@alaznah/calling` (confirm in `package.json`)  
**Status:** Public · Beta

WebRTC **1:1 voice and video calling** for React Native (iOS + Android), built for the Alaznah real-time stack.

## Related repositories

| Repository | Role |
| --- | --- |
| [alaznah-protocol](https://github.com/Alaznah/alaznah-protocol) | Shared signaling contracts |
| [alaznah-signaling](https://github.com/Alaznah/alaznah-signaling) | Hosted / self-host signaling + TURN |
| [alaznah-docs](https://github.com/Alaznah/alaznah-docs) | Developer portal & JWT mint (`alaznah.dev`) |
| [alaznah-examples](https://github.com/Alaznah/alaznah-examples) | Sample apps |

## Requirements

- React Native CLI app or Expo **development build** (not Expo Go)
- Peer packages as declared in `package.json` (typically `react-native-webrtc`, `react-native-incall-manager`, `@react-native-community/netinfo`)
- Calling JWT from your backend (never embed secrets in the app)

## Install

```bash
npm install @alaznah/calling
# install peers when prompted
cd ios && pod install && cd ..
```

## Quickstart

```tsx
import { Button } from 'react-native';
import {
  CallingProvider,
  useCallingClient,
  useCallingReady,
} from '@alaznah/calling';
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
        onPress={() =>
          void client.startCall({ calleeId: 'bob', mediaType: 'video' })
        }
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

## Production endpoints (Alaznah Cloud)

| Service | URL |
| --- | --- |
| Signaling (WSS) | `wss://signal.alaznah.com` |
| Health | `https://signal.alaznah.com/health` |
| Docs / console | `https://alaznah.dev` |

Self-host: point `signalingUrl` at your own `wss://` from **alaznah-signaling**.

## Mobile setup (summary)

- **Android:** FCM + app permissions (`CAMERA`, `RECORD_AUDIO`, notifications)
- **iOS:** microphone/camera usage strings, Push Notifications, VoIP background mode, APNs VoIP for kill-state
- Push credentials are configured on the **signaling** side; the SDK registers handlers only

## Known beta limits

- 1:1 calls only (group/SFU not shipped)
- Cellular networks need reachable TURN
- APIs may change before `1.0.0`

## Develop in this repo

```bash
npm install
npm run build
npm test
npm run pack:check
```

## License

MIT (confirm in `package.json` / `LICENSE`).
