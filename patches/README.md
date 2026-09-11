# react-native-webrtc iOS PiP patch

Production iOS Picture-in-Picture for `@alaznah/calling` requires this patch on
`react-native-webrtc` (tested with 124.0.7 / 124.0.8).

## Why

Stock RN-WebRTC:

1. Maps RTCView `objectFit: cover` to PiP `AVLayerVideoGravityResizeAspectFill`
   (zoomed/cropped PiP window).
2. Never calls `restoreUserInterface…completionHandler`.
3. Delays `stopPictureInPicture` by 0.5s on foreground (old UI visible beside PiP).
4. Optionally composites a local self-view inset into the PiP window.

This patch:

- Forces PiP sample-buffer gravity to `ResizeAspect` (inline Metal can use contain)
- Invokes the restore completion handler after laying out the source view
- Stops PiP **immediately** on foreground (no 0.5s delay)
- Posts `AlaznahWebRTCPip*` notifications for JS chrome sync, including
  `AlaznahWebRTCPipFailed` with the native error when PiP cannot start
- Ignores local inset binding — **remote-only** PiP composition
- Keeps preferred content size portrait

## Apply in your app

```bash
npm i -D patch-package
# copy this file next to your app package.json under patches/
```

In `package.json`:

```json
"scripts": {
  "postinstall": "patch-package"
}
```

Then reinstall and **rebuild the native iOS app** (`pod install` + device build).

The `@alaznah/example-basic-call` app already applies this via `postinstall`.
