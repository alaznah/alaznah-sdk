import React from 'react';
import { View } from 'react-native';

/** Placeholder waveform for audio-only calls (customize via UI slots). */
export function AudioWave({ active = false }: { active?: boolean }) {
  return (
    <View
      accessibilityLabel={active ? 'Audio active' : 'Audio idle'}
      style={{
        width: 120,
        height: 8,
        borderRadius: 4,
        backgroundColor: active ? '#00a884' : '#2a3942',
        opacity: active ? 1 : 0.55,
      }}
    />
  );
}
