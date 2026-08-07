import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { ActiveCall, CallingClient } from '../types/index.js';
import {
  CallEndIcon,
  MicIcon,
  MicOffIcon,
  SpeakerIcon,
  SpeakerOffIcon,
  VideoIcon,
  VideoOffIcon,
} from './icons.js';
import type { CallingTheme } from './theme.js';

type Props = {
  call: ActiveCall;
  client: CallingClient;
  theme: CallingTheme;
  onEnd: () => void;
  onError?: (error: Error) => void;
};

const BTN = 54;

function runControl(
  action: () => Promise<unknown> | void,
  onError?: (error: Error) => void,
): void {
  try {
    const result = action();
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      void (result as Promise<unknown>).catch((err) => {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    }
  } catch (err) {
    onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * WhatsApp-style bottom dock: Video · Speaker · Mute · End (no 3-dots, no flip/flash).
 * Active toggles use white circles; mute-on uses red glyph; end stays red.
 */
export function CallControls({ call, client, theme, onEnd, onError }: Props) {
  const icon = theme.icons.control;
  const id = call.callId;
  const isVideo = call.mediaType === 'video';

  return (
    <View style={styles.bar}>
      {isVideo ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={call.videoEnabled ? 'Turn camera off' : 'Turn camera on'}
          hitSlop={8}
          onPress={() =>
            runControl(() => client.setVideoEnabled(!call.videoEnabled, id), onError)
          }
          style={({ pressed }) => [
            styles.button,
            call.videoEnabled ? styles.btnOn : styles.btnOff,
            { opacity: pressed ? 0.85 : 1 },
          ]}
        >
          {call.videoEnabled ? (
            <VideoIcon size={icon} color="#111" />
          ) : (
            <VideoOffIcon size={icon} color="#fff" />
          )}
        </Pressable>
      ) : (
        <View style={[styles.button, styles.btnOff, { opacity: 0.45 }]}>
          <VideoOffIcon size={icon} color="#fff" />
        </View>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={call.speakerOn ? 'Speaker off' : 'Speaker on'}
        hitSlop={8}
        onPress={() => runControl(() => client.setSpeaker(!call.speakerOn, id), onError)}
        style={({ pressed }) => [
          styles.button,
          call.speakerOn ? styles.btnOn : styles.btnOff,
          { opacity: pressed ? 0.85 : 1 },
        ]}
      >
        {call.speakerOn ? (
          <SpeakerIcon size={icon} color="#111" />
        ) : (
          <SpeakerOffIcon size={icon} color="#fff" />
        )}
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={call.muted ? 'Unmute' : 'Mute'}
        hitSlop={8}
        onPress={() => runControl(() => client.setMuted(!call.muted, id), onError)}
        style={({ pressed }) => [
          styles.button,
          styles.btnOn,
          { opacity: pressed ? 0.85 : 1 },
        ]}
      >
        {call.muted ? (
          <MicOffIcon size={icon} color="#e83829" />
        ) : (
          <MicIcon size={icon} color="#111" />
        )}
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="End call"
        hitSlop={8}
        onPress={onEnd}
        style={({ pressed }) => [styles.endHit, { opacity: pressed ? 0.85 : 1 }]}
      >
        <CallEndIcon size={BTN} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    alignSelf: 'center',
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 12,
    gap: 14,
    maxWidth: 420,
    width: '90%',
    backgroundColor: 'rgba(55, 55, 55, 0.72)',
  },
  button: {
    width: BTN,
    height: BTN,
    borderRadius: BTN / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnOn: {
    backgroundColor: '#ffffff',
  },
  btnOff: {
    backgroundColor: 'rgba(80, 80, 80, 0.85)',
  },
  endHit: {
    width: BTN,
    height: BTN,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
