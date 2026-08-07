import { NativeModules } from 'react-native';
import CodegenAlaznahCalling from '../specs/NativeAlaznahCalling.js';
import type { Spec } from '../specs/NativeAlaznahCalling.js';

/**
 * Codegen is the primary path. NativeModules fallbacks keep consumers on the
 * legacy bridge working while they migrate to React Native's New Architecture.
 */
export const NativeAlaznahCalling: Spec | null =
  CodegenAlaznahCalling ??
  (NativeModules.AlaznahCalling as Spec | undefined) ??
  (NativeModules.IncomingCallNotification as Spec | undefined) ??
  null;
