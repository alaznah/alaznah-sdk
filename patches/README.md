# react-native-webrtc iOS PiP patch

Production iOS Picture-in-Picture for `@alaznah/calling` requires this patch on
`react-native-webrtc` (tested with 124.0.7 / 124.0.8).

**Source of truth:** this folder inside `@alaznah/calling` — do **not** maintain a
separate copy in the host/example app.

## Why

Stock RN-WebRTC PiP needs Alaznah fixes (remote-only composition, safe teardown,
placeholder when remote camera is off, lifecycle notifications).

## Apply in your app (recommended)

```bash
npm i -D patch-package
```

In the **host** `package.json`:

```json
"scripts": {
  "postinstall": "patch-package --patch-dir node_modules/@alaznah/calling/patches"
}
```

Then reinstall and **rebuild the native iOS app** (`pod install` + device build).

No need to copy patch files into your app — they ship with the SDK.
