# @alaznah/calling

**1:1 voice & video calling for React Native** — provider, hooks, and ready-made call UI on Alaznah Cloud.

> [!IMPORTANT]
> Public **beta**. APIs can still change before `1.0.0`. Prefer pinning a beta version and follow [docs.alaznah.com](https://docs.alaznah.com) for the latest guides.

---

## 🔍 Features

| Feature | Status |
|---------|--------|
| 📞 **1:1 voice calling** | ✅ Available |
| 🎥 **1:1 video calling** | ✅ Available |
| 🧩 **`CallingProvider` + hooks** (`useCallingClient`, `useCall`, …) | ✅ Available |
| 🖼️ **Built-in UI** — `CallingScreen` / `CallingUI` (incoming, outgoing, active) | ✅ Available |
| 🎨 **Themes & slots** for branded call chrome | ✅ Available |
| 🔐 **Short-lived JWT auth** (mint from your backend / Console Test Token) | ✅ Available |
| ☁️ **Hosted Signaling** (`wss://signal.alaznah.com`) | ✅ Available |
| 🏠 **Self-hosted signaling** (point `signalingUrl` at your WSS) | ✅ Available |
| 📱 **iOS & Android** (RN CLI / Expo **dev builds**) | ✅ Available |
| 🔔 **Push / background ringing** (Console credentials + docs) | ✅ Available |
| 👥 **Group calling** | 🗺️ Roadmap |

---

## ✨ Project Status

| Package | State | Notes |
|---------|-------|--------|
| **`@alaznah/calling` `0.1.x-beta`** | 🚀 Active beta | Public npm · New Architecture–friendly RN **0.76+** |
| **Protocol** [`@alaznah/protocol`](https://github.com/alaznah/alaznah-protocol) | ✅ Published | Shared message contracts |
| **Hosted Cloud** | ✅ Live | Signaling + Console minting |
| **`1.0.0`** | 🏗️ Ahead | Stabilize APIs, polish default UI, group calling |

---

## 📚 Documentation & Examples

| Resource | Link |
|----------|------|
| 📖 **Docs** | [docs.alaznah.com](https://docs.alaznah.com) |
| 🚀 **Quick Start** | [docs → Quick Start](https://docs.alaznah.com/docs/quick-start) |
| 📦 **Installation** | [docs → Installation](https://docs.alaznah.com/docs/installation) |
| 🧭 **Compatibility** | [docs → Compatibility](https://docs.alaznah.com/docs/compatibility) |
| 🔑 **Authentication** | [docs → Authentication](https://docs.alaznah.com/docs/authentication) |
| 🖼️ **Call UI** | [docs → Call UI](https://docs.alaznah.com/docs/call-ui) |
| 🎛️ **Console** | [console.alaznah.com](https://console.alaznah.com) |
| 📦 **npm** | [`@alaznah/calling`](https://www.npmjs.com/package/@alaznah/calling) |
| 🧪 **Examples** | [alaznah/alaznah-examples](https://github.com/alaznah/alaznah-examples) |

---

## 🚀 Quick Start

### Requirements

- React Native **0.76+**
- Android **compileSdk 35 or 36** · **minSdk 24**
- iOS **13+**
- RN **CLI** or Expo **development build** (Expo Go is **not** supported)
- `@alaznah/calling` requires the following React Native peer dependencies (see Install)
- Calling tokens from **your** backend (never ship API secrets in the app)

Full matrix: [Compatibility](https://docs.alaznah.com/docs/compatibility).

### Install

Pick your package manager — peers stay in **your app** (native modules are not bundled inside the SDK):

```bash
# npm — package, then required peers
npm install @alaznah/calling
npm install react-native-webrtc react-native-incall-manager @react-native-community/netinfo react-native-svg

# Yarn — one line
yarn add @alaznah/calling react-native-webrtc react-native-incall-manager @react-native-community/netinfo react-native-svg

# pnpm — one line
pnpm add @alaznah/calling react-native-webrtc react-native-incall-manager @react-native-community/netinfo react-native-svg

cd ios && pod install && cd ..
# rebuild the native app after install
```

`@alaznah/calling` requires the following React Native peer dependencies:

**REQUIRED**

- `react-native-webrtc`
- `react-native-incall-manager`
- `@react-native-community/netinfo`
- `react-native-svg`

Your React Native app already includes `react` and `react-native`.

**OPTIONAL**

- `react-native-callkeep` — only when you explicitly choose CallKeep integration. The SDK’s own native calling path does not require CallKeep.

Without `react-native-webrtc`, `startCall` fails with **WebRTC adapters not found**.

More: [Installation](https://docs.alaznah.com/docs/installation).

### Usage

```tsx
import { Button } from 'react-native';
import {
  CallingProvider,
  CallingUI,
  useCallingClient,
  useCallingReady,
} from '@alaznah/calling';
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
        // omit signalingUrl to use Hosted Signaling default
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

> **Tip:** For the fastest first call, use **`CallingScreen`** from `@alaznah/calling` (built-in dialer + incoming + active). Chat apps usually mount **`CallingUI`** as an overlay — [Call UI](https://docs.alaznah.com/docs/call-ui).

Incoming accept is **swipe up** on the green control (tap does not accept).

---

## ☁️ Alaznah Cloud

| Service | Endpoint |
|---------|----------|
| 📡 Signaling | `wss://signal.alaznah.com` |
| ❤️ Health | `https://signal.alaznah.com/health` |
| 📖 Docs | [docs.alaznah.com](https://docs.alaznah.com) |
| 🎛️ Console | [console.alaznah.com](https://console.alaznah.com) |

Self-hosting: set `signalingUrl` to your own `wss://` endpoint. Operator source: [alaznah/alaznah-signaling](https://github.com/alaznah/alaznah-signaling) (private).

---

## ✅ Mobile checklist

- [ ] Camera / microphone permissions (+ iOS usage strings)
- [ ] Peer deps installed + **native rebuild**
- [ ] Distinct `userId` per device (must match token claim)
- [ ] Fresh calling JWT from Console Test Token or your mint API
- [ ] Physical devices for real media tests
- [ ] Push credentials for background / kill-state ringing

---

## 🧪 Develop in this repo

```bash
npm install
npm run build
npm test
npm run pack:check
```

| Related repo | Role |
|--------------|------|
| [alaznah-protocol](https://github.com/alaznah/alaznah-protocol) | Wire protocol |
| [alaznah-signaling](https://github.com/alaznah/alaznah-signaling) | Signaling server (private) |
| [alaznah-examples](https://github.com/alaznah/alaznah-examples) | Sample apps |
| [alaznah-docs](https://github.com/alaznah/alaznah-docs) | Docs site (private) |

---

## 📄 License

MIT — see [`LICENSE`](./LICENSE).
