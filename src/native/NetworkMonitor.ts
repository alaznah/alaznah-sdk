export type NetworkState = {
  isConnected: boolean;
  type: string;
  isInternetReachable: boolean | null;
};

export type NetworkMonitor = {
  start: (onChange: (state: NetworkState) => void) => () => void;
  getState: () => Promise<NetworkState>;
};

const defaultState: NetworkState = {
  isConnected: true,
  type: 'unknown',
  isInternetReachable: true,
};

/**
 * Uses @react-native-community/netinfo when available; otherwise a no-op online stub.
 */
export function createNetworkMonitor(): NetworkMonitor {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const NetInfo = require('@react-native-community/netinfo');
    const api = NetInfo.default ?? NetInfo;
    return {
      start(onChange) {
        const unsub = api.addEventListener((state: {
          isConnected: boolean | null;
          type: string;
          isInternetReachable: boolean | null;
        }) => {
          onChange({
            isConnected: Boolean(state.isConnected),
            type: state.type,
            isInternetReachable: state.isInternetReachable,
          });
        });
        return () => unsub();
      },
      async getState() {
        const state = await api.fetch();
        return {
          isConnected: Boolean(state.isConnected),
          type: state.type,
          isInternetReachable: state.isInternetReachable,
        };
      },
    };
  } catch {
    return {
      start() {
        return () => undefined;
      },
      async getState() {
        return defaultState;
      },
    };
  }
}
