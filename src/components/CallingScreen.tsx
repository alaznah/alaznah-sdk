import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useCall, useCallingClient, useCallingReady, useIncomingCall } from '../hooks/CallingContext.js';
import { CallingUI } from './CallingUI.js';
import { defaultCallingTheme } from './theme.js';

export type CallingScreenProps = {
  userId: string;
  defaultPeerId?: string;
  onLogout?: () => void;
  onError?: (error: Error) => void;
  /** When set, registers with signaling once the client is ready. */
  pushToken?: string | null;
  pushPlatform?: 'ios' | 'android';
};

/**
 * Default calling screen — library call UI (`CallingUI`) with a minimal dialer.
 * Replace the dialer section with your own navigation when integrating.
 */
export function CallingScreen({
  userId,
  defaultPeerId,
  onLogout,
  onError,
  pushToken,
  pushPlatform = 'ios',
}: CallingScreenProps) {
  const theme = defaultCallingTheme;
  const client = useCallingClient();
  const ready = useCallingReady();
  const call = useCall();
  const incoming = useIncomingCall();
  const [peerId, setPeerId] = useState(defaultPeerId ?? (userId === 'alice' ? 'bob' : 'alice'));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pushToken || !ready) return;
    void client
      .registerPushToken(pushToken, pushPlatform)
      .catch((err) => console.warn('[CallingScreen] registerPushToken failed', err));
  }, [client, pushPlatform, pushToken, ready]);

  const reportError = (message: string) => {
    setError(message);
    onError?.(new Error(message));
  };

  const run = (operation: () => Promise<unknown>) => {
    setError(null);
    operation().catch((reason) => {
      reportError(reason instanceof Error ? reason.message : String(reason));
    });
  };

  const status = useMemo(() => {
    if (!ready) return 'Connecting to signaling…';
    if (incoming?.state === 'ringing') {
      return `Incoming ${incoming.mediaType} call from ${incoming.peerId}`;
    }
    if (call) return `${call.peerId}: ${call.state}`;
    return 'Ready to call';
  }, [call, incoming, ready]);

  const callActive =
    call != null &&
    !['ended', 'failed', 'rejected', 'missed', 'busy'].includes(call.state);
  const showIncoming = incoming?.state === 'ringing';
  const showDialer = ready && !callActive && !showIncoming;

  return (
    <View style={[styles.screen, { backgroundColor: theme.colors.background }]}>
      <StatusBar barStyle="light-content" backgroundColor={theme.colors.background} />

      {showDialer ? (
        <View style={styles.dialer}>
          <Text style={[styles.title, { color: theme.colors.text }]}>Calls</Text>
          <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
            Signed in as {userId}
          </Text>
          <View style={styles.statusRow}>
            <View style={[styles.dot, { backgroundColor: theme.colors.success }]} />
            <Text style={[styles.status, { color: theme.colors.text }]}>{status}</Text>
          </View>

          {onLogout ? (
            <Pressable accessibilityRole="button" onPress={onLogout} style={styles.logout}>
              <Text style={[styles.logoutText, { color: theme.colors.danger }]}>Logout</Text>
            </Pressable>
          ) : null}

          {error ? (
            <Text style={[styles.error, { color: theme.colors.danger }]}>{error}</Text>
          ) : null}

          <Text style={[styles.label, { color: theme.colors.text }]}>Call user</Text>
          <TextInput
            accessibilityLabel="Peer user ID"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setPeerId}
            placeholder="bob"
            placeholderTextColor={theme.colors.textMuted}
            style={[
              styles.input,
              {
                backgroundColor: theme.colors.background,
                borderColor: theme.colors.control,
                color: theme.colors.text,
              },
            ]}
            value={peerId}
          />

          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              disabled={!peerId.trim()}
              onPress={() =>
                run(() =>
                  client.startCall({ calleeId: peerId.trim(), mediaType: 'audio' }),
                )
              }
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: theme.colors.accent, opacity: pressed ? 0.85 : 1 },
                !peerId.trim() && styles.disabled,
              ]}
            >
              <Text style={styles.buttonText}>Audio call</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={!peerId.trim()}
              onPress={() =>
                run(() =>
                  client.startCall({ calleeId: peerId.trim(), mediaType: 'video' }),
                )
              }
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: theme.colors.accent, opacity: pressed ? 0.85 : 1 },
                !peerId.trim() && styles.disabled,
              ]}
            >
              <Text style={styles.buttonText}>Video call</Text>
            </Pressable>
          </View>
        </View>
      ) : !ready ? (
        <View style={styles.loaderWrap}>
          <ActivityIndicator color={theme.colors.accent} size="large" />
          <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>{status}</Text>
        </View>
      ) : null}

      <CallingUI client={client} onError={(err) => reportError(err.message)} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  dialer: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 24,
  },
  loaderWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  title: { fontSize: 22, fontWeight: '800' },
  subtitle: { fontSize: 14, marginTop: 4 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  status: { fontSize: 14 },
  logout: { alignSelf: 'flex-start', marginTop: 10 },
  logoutText: { fontSize: 13, fontWeight: '600' },
  error: { marginTop: 12, fontSize: 13 },
  label: { fontSize: 13, fontWeight: '600', marginTop: 20, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginBottom: 12,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  button: {
    borderRadius: 999,
    minWidth: 120,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  disabled: { opacity: 0.45 },
  buttonText: { color: '#ffffff', fontWeight: '700', textAlign: 'center' },
});
