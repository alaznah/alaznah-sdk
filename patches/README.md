# react-native-webrtc iOS PiP patch

iOS Picture-in-Picture patches `react-native-webrtc` (124.0.7 / 124.0.8).
Only iOS source files are patched.

**Applied automatically** from SDK `postinstall` and again on iOS compile
(`AlaznahCalling` script phase) so a `file:` / install-order miss still patches.
Integrators do **not** add `patch-package` or a host `postinstall` line.

Works with `react-native-webrtc` 124.0.7 and 124.0.8 (same iOS sources).

Voice/video work without it; iOS Home / Minimize PiP uses these native fixes
(remote-only composition, camera-off placeholder, startPIP retries, safe teardown).
