import type { ReactElement } from 'react';
import type { ImageSourcePropType, StyleProp, ViewStyle } from 'react-native';
import type { ActiveCall, CallingClient } from '../types/index.js';
import type { CallingTheme } from './theme.js';

export type CallingUISlots = {
  renderAvatar?: (call: ActiveCall) => ReactElement | null;
  renderHeader?: (call: ActiveCall) => ReactElement | null;
  renderStatus?: (call: ActiveCall) => ReactElement | null;
  renderControls?: (call: ActiveCall) => ReactElement | null;
  renderOverlay?: (call: ActiveCall) => ReactElement | null;
};

export type CallingUIProps = {
  client: CallingClient;
  theme?: Partial<CallingTheme>;
  /** Optional background image/color override for call screens. */
  backgroundColor?: string;
  backgroundImage?: ImageSourcePropType;
  slots?: CallingUISlots;
  renderIncomingScreen?: (props: {
    call: ActiveCall;
    onAccept: (options?: { videoEnabled?: boolean }) => void;
    onReject: () => void;
  }) => ReactElement | null;
  renderActiveCallScreen?: (props: {
    call: ActiveCall;
    onEnd: () => void;
  }) => ReactElement | null;
  style?: StyleProp<ViewStyle>;
  onError?: (error: Error) => void;
};
