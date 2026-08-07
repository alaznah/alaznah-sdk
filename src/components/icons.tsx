import React from 'react';
import { View, type ViewStyle } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

export type IconProps = {
  size?: number;
  color?: string;
  style?: ViewStyle;
};

const STROKE = 2;

function IconWrap({
  size = 24,
  style,
  children,
}: {
  size?: number;
  style?: ViewStyle;
  children: React.JSX.Element | React.JSX.Element[];
}) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        { width: size, height: size, alignItems: 'center', justifyContent: 'center' },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const stroke = (color: string) => ({
  stroke: color,
  strokeWidth: STROKE,
  fill: 'none' as const,
});

function strokeSvg(size: number, style: ViewStyle | undefined, nodes: React.JSX.Element[]) {
  return (
    <IconWrap size={size} style={style}>
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        {nodes}
      </Svg>
    </IconWrap>
  );
}

/** Handset — end / decline / accept (same glyph family). */
const END_PHONE_PATH =
  'M23.59 12.048C20.495 8.793 16.379 7 12 7 7.62 7 3.503 8.793.41 12.048c-.272.286-.41.661-.41 1.037 0 .377.137.754.41 1.041l2.305 2.425c.542.57 1.504.57 2.046 0 .77-.81 1.506-1.48 2.46-1.984.477-.246.785-.764.78-1.254L8 10.685c2.512-.803 5.512-.804 8 0l.005 2.562c0 .554.294 1.06.775 1.324.958.508 1.681 1.176 2.453 1.987.27.285.634.442 1.023.442a1.4 1.4 0 0 0 1.022-.442l2.312-2.432c.293-.308.414-.626.41-1.126a1.42 1.42 0 0 0-.41-.952';

/** @deprecated Large-path accept art — use END_PHONE_PATH rotation instead */
const ACCEPT_PHONE_PATH =
  'M353.188 252.052c-23.51 0-46.594-3.677-68.469-10.906-10.719-3.656-23.896-.302-30.438 6.417l-43.177 32.594c-50.073-26.729-80.917-57.563-107.281-107.26l31.635-42.052c8.219-8.208 11.167-20.198 7.635-31.448-7.26-21.99-10.948-45.063-10.948-68.583C132.146 13.823 118.323 0 101.333 0h-70.52C13.823 0 0 13.823 0 30.813 0 225.563 158.438 384 353.188 384c16.99 0 30.813-13.823 30.813-30.813v-70.323c-.001-16.989-13.824-30.812-30.813-30.812';

type CircularCallIconProps = IconProps & {
  /** Icon only — parent supplies the circle background. */
  iconOnly?: boolean;
  backgroundColor?: string;
};

function CircularCallIcon({
  size = 28,
  color = '#ffffff',
  style,
  iconOnly = false,
  backgroundColor,
  viewBox,
  path,
  pathTransform,
}: CircularCallIconProps & {
  viewBox: string;
  path: string;
  pathTransform?: string;
}) {
  const circleSize = size;
  const iconSize = iconOnly ? size : Math.round(size * 0.52);

  const glyph = (
    <Svg width={iconSize} height={iconSize} viewBox={viewBox}>
      <Path d={path} fill={color} transform={pathTransform} />
    </Svg>
  );

  if (iconOnly) {
    return (
      <IconWrap size={circleSize} style={style}>
        {glyph}
      </IconWrap>
    );
  }

  return (
    <IconWrap size={circleSize} style={style}>
      <Svg width={circleSize} height={circleSize} viewBox={`0 0 ${circleSize} ${circleSize}`}>
        <Circle
          cx={circleSize / 2}
          cy={circleSize / 2}
          r={circleSize / 2}
          fill={backgroundColor}
        />
      </Svg>
      <View
        style={{
          position: 'absolute',
          width: circleSize,
          height: circleSize,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {glyph}
      </View>
    </IconWrap>
  );
}

// ——— In-call controls (stroke, currentColor) ———

export function MicIcon({ size = 24, color = '#fff', style }: IconProps) {
  const s = stroke(color);
  return strokeSvg(size, style, [
    <Path key="1" d="M12 15a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z" {...s} strokeLinecap="round" strokeLinejoin="round" />,
    <Path key="2" d="M6 11v1a6 6 0 0 0 12 0v-1" {...s} strokeLinecap="round" />,
    <Path key="3" d="M12 18v3" {...s} strokeLinecap="round" />,
    <Path key="4" d="M9 21h6" {...s} strokeLinecap="round" />,
  ]);
}

export function MicOffIcon({ size = 24, color = '#fff', style }: IconProps) {
  const s = stroke(color);
  return strokeSvg(size, style, [
    <Path key="1" d="M15 9V7a3 3 0 1 0-6 0v2" {...s} strokeLinecap="round" />,
    <Path key="2" d="M9 11v1a3 3 0 0 0 4.2 2.8" {...s} strokeLinecap="round" />,
    <Path key="3" d="M6 11v1a6 6 0 0 0 6 6" {...s} strokeLinecap="round" />,
    <Path key="4" d="M12 18v3" {...s} strokeLinecap="round" />,
    <Path key="5" d="M9 21h6" {...s} strokeLinecap="round" />,
    <Path key="6" d="M4 4l16 16" {...s} strokeLinecap="round" />,
  ]);
}

export function VideoIcon({ size = 24, color = '#fff', style }: IconProps) {
  const s = stroke(color);
  return strokeSvg(size, style, [
    <Rect key="1" x="3" y="6" width="13" height="12" rx="2" {...s} />,
    <Path key="2" d="M16 10l5-3v10l-5-3z" {...s} strokeLinejoin="round" />,
  ]);
}

export function VideoOffIcon({ size = 24, color = '#fff', style }: IconProps) {
  const s = stroke(color);
  return strokeSvg(size, style, [
    <Rect key="1" x="3" y="6" width="13" height="12" rx="2" {...s} />,
    <Path key="2" d="M16 10l5-3v10l-5-3z" {...s} strokeLinejoin="round" />,
    <Path key="3" d="M4 4L20 20" {...s} strokeLinecap="round" />,
  ]);
}

export function SpeakerIcon({ size = 24, color = '#fff', style }: IconProps) {
  const s = stroke(color);
  return strokeSvg(size, style, [
    <Path key="1" d="M11 5L6 9H3v6h3l5 4V5Z" {...s} strokeLinejoin="round" />,
    <Path key="2" d="M16 9a4 4 0 0 1 0 6" {...s} strokeLinecap="round" />,
    <Path key="3" d="M18.5 6.5a7.5 7.5 0 0 1 0 11" {...s} strokeLinecap="round" />,
  ]);
}

export function SpeakerOffIcon({ size = 24, color = '#fff', style }: IconProps) {
  const s = stroke(color);
  return strokeSvg(size, style, [
    <Path key="1" d="M11 5L6 9H3v6h3l5 4V5Z" {...s} strokeLinejoin="round" />,
    <Path key="2" d="M4 4L20 20" {...s} strokeLinecap="round" />,
  ]);
}

export function FlipCameraIcon({ size = 24, color = '#fff', style }: IconProps) {
  const s = stroke(color);
  return strokeSvg(size, style, [
    <Path
      key="1"
      d="M20 8h-2.5l-1.2-1.8A2 2 0 0 0 14.7 5H9.3a2 2 0 0 0-1.6.8L6.5 8H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2Z"
      {...s}
      strokeLinejoin="round"
    />,
    <Circle key="2" cx="12" cy="14" r="3.2" {...s} />,
    <Path key="3" d="M16.5 5.5a3.5 3.5 0 0 1 3 1.8" {...s} strokeLinecap="round" />,
    <Path key="4" d="M19.2 5v2.4h-2.4" {...s} strokeLinecap="round" strokeLinejoin="round" />,
  ]);
}

/** WhatsApp-style torch — sun with rays. */
export function FlashIcon({ size = 24, color = '#fff', style }: IconProps) {
  const s = stroke(color);
  return strokeSvg(size, style, [
    <Circle key="c" cx="12" cy="12" r="3.5" {...s} />,
    <Path key="1" d="M12 2v2.5" {...s} strokeLinecap="round" />,
    <Path key="2" d="M12 19.5V22" {...s} strokeLinecap="round" />,
    <Path key="3" d="M4.93 4.93l1.77 1.77" {...s} strokeLinecap="round" />,
    <Path key="4" d="M17.3 17.3l1.77 1.77" {...s} strokeLinecap="round" />,
    <Path key="5" d="M2 12h2.5" {...s} strokeLinecap="round" />,
    <Path key="6" d="M19.5 12H22" {...s} strokeLinecap="round" />,
    <Path key="7" d="M4.93 19.07l1.77-1.77" {...s} strokeLinecap="round" />,
    <Path key="8" d="M17.3 6.7l1.77-1.77" {...s} strokeLinecap="round" />,
  ]);
}

export function FlashOffIcon({ size = 24, color = '#fff', style }: IconProps) {
  const s = stroke(color);
  return strokeSvg(size, style, [
    <Circle key="c" cx="12" cy="12" r="3.5" {...s} />,
    <Path key="1" d="M12 2v2.5" {...s} strokeLinecap="round" />,
    <Path key="2" d="M12 19.5V22" {...s} strokeLinecap="round" />,
    <Path key="3" d="M4.93 4.93l1.77 1.77" {...s} strokeLinecap="round" />,
    <Path key="4" d="M17.3 17.3l1.77 1.77" {...s} strokeLinecap="round" />,
    <Path key="5" d="M2 12h2.5" {...s} strokeLinecap="round" />,
    <Path key="6" d="M19.5 12H22" {...s} strokeLinecap="round" />,
    <Path key="7" d="M4.93 19.07l1.77-1.77" {...s} strokeLinecap="round" />,
    <Path key="8" d="M17.3 6.7l1.77-1.77" {...s} strokeLinecap="round" />,
    <Path key="x" d="M4 4l16 16" {...s} strokeLinecap="round" />,
  ]);
}

export function MinimizeIcon({ size = 24, color = '#fff', style }: IconProps) {
  const s = stroke(color);
  return strokeSvg(size, style, [
    <Path key="1" d="M9 4H4v5" {...s} strokeLinecap="round" strokeLinejoin="round" />,
    <Path key="2" d="M4 4l6 6" {...s} strokeLinecap="round" />,
    <Path key="3" d="M15 20h5v-5" {...s} strokeLinecap="round" strokeLinejoin="round" />,
    <Path key="4" d="M20 20l-6-6" {...s} strokeLinecap="round" />,
  ]);
}

export function AddPersonIcon({ size = 24, color = '#fff', style }: IconProps) {
  const s = stroke(color);
  return strokeSvg(size, style, [
    <Path key="1" d="M15 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1" {...s} strokeLinecap="round" />,
    <Circle key="2" cx="8.5" cy="7.5" r="3" {...s} />,
    <Path key="3" d="M18 8v6" {...s} strokeLinecap="round" />,
    <Path key="4" d="M21 11h-6" {...s} strokeLinecap="round" />,
  ]);
}

export function ChatIcon({ size = 24, color = '#fff', style }: IconProps) {
  const s = stroke(color);
  return strokeSvg(size, style, [
    <Path
      key="1"
      d="M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-4.2A8 8 0 1 1 21 12Z"
      {...s}
      strokeLinejoin="round"
    />,
  ]);
}

export function MoreIcon({ size = 24, color = '#fff', style }: IconProps) {
  const s = stroke(color);
  return strokeSvg(size, style, [
    <Path key="1" d="M6 12h.01" {...s} strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} />,
    <Path key="2" d="M12 12h.01" {...s} strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} />,
    <Path key="3" d="M18 12h.01" {...s} strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} />,
  ]);
}

export function ChevronUpIcon({ size = 24, color = '#fff', style }: IconProps) {
  const s = stroke(color);
  return strokeSvg(size, style, [
    <Path key="1" d="m6 15 6-6 6 6" {...s} strokeLinecap="round" strokeLinejoin="round" />,
  ]);
}

// ——— Call actions (filled handset on optional circle) ———

const CALL_ACCEPT_GREEN = '#4caf50';
const CALL_END_RED = '#e83829';

/** White handset only — use inside themed control buttons. */
export function PhoneEndIcon({ size = 24, color = '#ffffff', style }: IconProps) {
  return (
    <CircularCallIcon
      size={size}
      color={color}
      style={style}
      iconOnly
      viewBox="0 0 24 24"
      path={END_PHONE_PATH}
    />
  );
}

/** End call with red circle + white handset. */
export function CallEndIcon(props: IconProps) {
  return (
    <CircularCallIcon
      {...props}
      backgroundColor={CALL_END_RED}
      viewBox="0 0 24 24"
      path={END_PHONE_PATH}
    />
  );
}

/** Accept — green circle + flipped handset (answer orientation). */
export function CallAcceptIcon(props: IconProps) {
  return (
    <CircularCallIcon
      {...props}
      color="#ffffff"
      backgroundColor={CALL_ACCEPT_GREEN}
      viewBox="0 0 24 24"
      path={END_PHONE_PATH}
      pathTransform="scale(-1,1) translate(-24,0) rotate(135,12,12)"
    />
  );
}

/** Decline — identical to end-call (red circle + white handset). */
export function CallDeclineIcon(props: IconProps) {
  return <CallEndIcon {...props} />;
}

/** @deprecated Use CallAcceptIcon — kept for slot overrides */
export function PhoneIcon(props: IconProps) {
  return (
    <CircularCallIcon
      {...props}
      iconOnly
      color={props.color ?? '#ffffff'}
      viewBox="0 0 384 384"
      path={ACCEPT_PHONE_PATH}
    />
  );
}
