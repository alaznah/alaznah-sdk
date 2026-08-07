export type CallingTheme = {
  colors: {
    background: string;
    surface: string;
    text: string;
    textMuted: string;
    accent: string;
    danger: string;
    success: string;
    control: string;
    controlActive: string;
    /** WhatsApp-style floating control pill background */
    controlBar: string;
    /** Muted / disabled icon on control buttons */
    iconDisabled: string;
    overlay: string;
  };
  spacing: {
    xs: number;
    sm: number;
    md: number;
    lg: number;
    xl: number;
  };
  typography: {
    title: number;
    subtitle: number;
    body: number;
    caption: number;
  };
  radii: {
    control: number;
    avatar: number;
    card: number;
  };
  icons: {
    control: number;
  };
};

export const defaultCallingTheme: CallingTheme = {
  colors: {
    background: '#0b141a',
    surface: '#1f2c34',
    text: '#e9edef',
    textMuted: '#8696a0',
    accent: '#00a884',
    danger: '#e83829',
    success: '#4caf50',
    control: '#3b4a54',
    controlActive: '#00a884',
    controlBar: '#1a2328',
    iconDisabled: '#667781',
    overlay: 'rgba(0,0,0,0.45)',
  },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  typography: { title: 28, subtitle: 16, body: 15, caption: 13 },
  radii: { control: 26, avatar: 64, card: 16 },
  icons: { control: 22 },
};

export function mergeTheme(partial?: Partial<CallingTheme>): CallingTheme {
  if (!partial) return defaultCallingTheme;
  return {
    ...defaultCallingTheme,
    ...partial,
    colors: { ...defaultCallingTheme.colors, ...partial.colors },
    spacing: { ...defaultCallingTheme.spacing, ...partial.spacing },
    typography: { ...defaultCallingTheme.typography, ...partial.typography },
    radii: { ...defaultCallingTheme.radii, ...partial.radii },
    icons: { ...defaultCallingTheme.icons, ...partial.icons },
  };
}
