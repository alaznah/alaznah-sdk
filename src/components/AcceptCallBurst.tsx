import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { VideoIcon } from './icons.js';

/** Exact phone glyph from Untitled file.svg */
const PHONE_PATH =
  'M-23.013,-21.156C-24.803,-17.182,-27.335,-10.896,-20.109,0.263C-15.207,8.563,-4.762,18.424,-4.762,18.424C-4.762,18.424,9,29.75,20.625,21.75C31.136,15.44,18.189,6.324,14.75,5.5C9.375,6.437,10.25,9.875,6,10.125C1.75,10.375,-9.246,-4.333,-9.5,-6.875C-7.875,-11.375,-5.72,-11.097,-5.114,-15.082C-4.816,-18.423,-15.848,-34.96,-23.013,-21.156Z';

const ACCEPT_GREEN = '#16a34a';
/** Accept / decline button diameter */
export const ACCEPT_BTN_SIZE = 56;
const SIZE = ACCEPT_BTN_SIZE;
const ICON_SIZE = 38;
/** Original SVG active window = 0.393 of 5s ≈ 2s */
export const ACCEPT_BURST_LOOP_MS = 2000;
const ORIG_VISIBLE = 0.393;
/** SVG rest 0.622 → peak 0.702 (~1.13×). Slightly stronger so pulse is obvious on device. */
const CIRCLE_PEAK = 1.18;

const easePulse = Easing.bezier(0.333, 0, 0.667, 1);
const easeRipple = Easing.bezier(0.167, 0.167, 0.314, 1);

function mapMs(keyTimeOn5s: number) {
  return Math.round((keyTimeOn5s / ORIG_VISIBLE) * ACCEPT_BURST_LOOP_MS);
}

function keyframeSequence(
  value: Animated.Value,
  frames: Array<{ t: number; v: number }>,
  easing: (n: number) => number = Easing.linear,
) {
  const steps: Animated.CompositeAnimation[] = [];
  for (let i = 1; i < frames.length; i++) {
    const dur = Math.max(0, frames[i].t - frames[i - 1].t);
    if (dur === 0) continue;
    if (frames[i].v === frames[i - 1].v) {
      steps.push(Animated.delay(dur));
    } else {
      steps.push(
        Animated.timing(value, {
          toValue: frames[i].v,
          duration: dur,
          easing,
          useNativeDriver: true,
        }),
      );
    }
  }
  const lastT = frames[frames.length - 1]?.t ?? 0;
  if (lastT < ACCEPT_BURST_LOOP_MS) {
    steps.push(Animated.delay(ACCEPT_BURST_LOOP_MS - lastT));
  }
  return Animated.sequence(steps);
}

type Props = {
  isVideo?: boolean;
  paused?: boolean;
};

/**
 * Untitled SVG layers (siblings): ripples → green circle pulse → icon rotate.
 * Circle and icon are NOT nested so background breath is visible.
 */
export function AcceptCallBurst({ isVideo = false, paused = false }: Props) {
  const circleScale = useRef(new Animated.Value(1)).current;
  const iconRotate = useRef(new Animated.Value(-4)).current;
  const r0 = useRef(new Animated.Value(0)).current;
  const r1 = useRef(new Animated.Value(0)).current;
  const r2 = useRef(new Animated.Value(0)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (paused) {
      animRef.current?.stop();
      circleScale.setValue(1);
      iconRotate.setValue(-4);
      r0.setValue(0);
      r1.setValue(0);
      r2.setValue(0);
      return undefined;
    }

    const pulse = keyframeSequence(
      circleScale,
      [
        { t: mapMs(0), v: 1 },
        { t: mapMs(0.02), v: 1 },
        { t: mapMs(0.193333), v: CIRCLE_PEAK },
        { t: mapMs(0.366667), v: 1 },
        { t: ACCEPT_BURST_LOOP_MS, v: 1 },
      ],
      easePulse,
    );

    const shake = keyframeSequence(
      iconRotate,
      [
        { t: mapMs(0), v: -4 },
        { t: mapMs(0.033333), v: -4 },
        { t: mapMs(0.059193), v: -8 },
        { t: mapMs(0.08506), v: 4 },
        { t: mapMs(0.11092), v: -8 },
        { t: mapMs(0.13678), v: 4 },
        { t: mapMs(0.162647), v: -8 },
        { t: mapMs(0.1885), v: 4 },
        { t: mapMs(0.213333), v: -4 },
        { t: ACCEPT_BURST_LOOP_MS, v: -4 },
      ],
      Easing.linear,
    );

    const rippleAnim = (v: Animated.Value, beginKey: number) => {
      const begin = mapMs(beginKey);
      const expand = Math.max(80, mapMs(0.193333) - mapMs(0.02));
      return Animated.sequence([
        Animated.delay(begin),
        Animated.timing(v, { toValue: 0, duration: 0, useNativeDriver: true }),
        Animated.timing(v, {
          toValue: 1,
          duration: expand,
          easing: easeRipple,
          useNativeDriver: true,
        }),
        Animated.timing(v, { toValue: 0, duration: 0, useNativeDriver: true }),
        Animated.delay(Math.max(0, ACCEPT_BURST_LOOP_MS - begin - expand)),
      ]);
    };

    animRef.current = Animated.loop(
      Animated.parallel([
        pulse,
        shake,
        rippleAnim(r0, 0),
        rippleAnim(r1, 0.033),
        rippleAnim(r2, 0.066333),
      ]),
    );
    animRef.current.start();
    return () => animRef.current?.stop();
  }, [circleScale, iconRotate, paused, r0, r1, r2]);

  const rotateStr = iconRotate.interpolate({
    inputRange: [-8, 4],
    outputRange: ['-8deg', '4deg'],
  });

  const rippleStyle = (progress: Animated.Value) => ({
    opacity: progress.interpolate({
      inputRange: [0, 0.1, 1],
      outputRange: [0.35, 0.28, 0],
    }),
    transform: [
      {
        scale: progress.interpolate({
          inputRange: [0, 1],
          outputRange: [1, 1 / 0.622],
        }),
      },
    ],
  });

  return (
    <View style={styles.wrap}>
      {/* Background ripples (SVG white rings) */}
      <Animated.View pointerEvents="none" style={[styles.ripple, rippleStyle(r0)]} />
      <Animated.View pointerEvents="none" style={[styles.ripple, rippleStyle(r1)]} />
      <Animated.View pointerEvents="none" style={[styles.ripple, rippleStyle(r2)]} />

      {/* Green circle — scale pulse ONLY (sibling of icon, like SVG) */}
      <Animated.View
        pointerEvents="none"
        style={[styles.circle, { transform: [{ scale: circleScale }] }]}
      />

      {/* Icon — rotate shake ONLY, not nested in circle */}
      <Animated.View
        pointerEvents="none"
        style={[styles.iconLayer, { transform: [{ rotate: rotateStr }, { scale: 0.94 }] }]}
      >
        {isVideo ? (
          <VideoIcon size={24} color="#fff" />
        ) : (
          <Svg width={ICON_SIZE} height={ICON_SIZE} viewBox="-36 -36 72 72">
            <Path d={PHONE_PATH} fill="#ffffff" />
          </Svg>
        )}
      </Animated.View>
    </View>
  );
}

// Layout box matches decline button; ripples overflow outside.
const styles = StyleSheet.create({
  wrap: {
    width: SIZE,
    height: SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible',
  },
  circle: {
    position: 'absolute',
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    backgroundColor: ACCEPT_GREEN,
  },
  iconLayer: {
    position: 'absolute',
    width: SIZE,
    height: SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ripple: {
    position: 'absolute',
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    backgroundColor: '#ffffff',
  },
});
