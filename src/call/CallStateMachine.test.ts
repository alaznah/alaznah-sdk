import { describe, expect, it } from 'vitest';
import { canTransition, isTerminalState, transitionCallState } from './CallStateMachine.js';

describe('CallStateMachine', () => {
  it('allows connecting to ringing', () => {
    expect(canTransition('connecting', 'ringing')).toBe(true);
    expect(transitionCallState('connecting', 'ringing')).toBe('ringing');
  });

  it('allows connecting to missed when invite expires or peer is offline', () => {
    expect(canTransition('connecting', 'missed')).toBe(true);
    expect(transitionCallState('connecting', 'missed')).toBe('missed');
  });

  it('blocks invalid transitions', () => {
    expect(canTransition('ended', 'connected')).toBe(false);
    expect(() => transitionCallState('ended', 'connected')).toThrow(/Invalid call state/);
  });

  it('detects terminal states', () => {
    expect(isTerminalState('ended')).toBe(true);
    expect(isTerminalState('connected')).toBe(false);
  });
});
