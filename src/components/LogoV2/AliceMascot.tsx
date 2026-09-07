import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { env } from '../../utils/env.js';

export type AlicePose = 'default' | 'arms-up' | 'look-left' | 'look-right';

type Props = {
  pose?: AlicePose;
};

type Segments = {
  r1L: string;
  r1E: string;
  r1R: string;
  r2L: string;
  r2R: string;
};

const POSES: Record<AlicePose, Segments> = {
  default: { r1L: '▞▐', r1E: '▛███▜', r1R: '▌▚', r2L: '▝▜', r2R: '▛▘' },
  'look-left': { r1L: '▞▐', r1E: '▟███▟', r1R: '▌▚', r2L: '▝▜', r2R: '▛▘' },
  'look-right': { r1L: '▞▐', r1E: '▙███▙', r1R: '▌▚', r2L: '▝▜', r2R: '▛▘' },
  'arms-up': { r1L: '▗▟', r1E: '▛███▜', r1R: '▙▖', r2L: ' ▜', r2R: '▛ ' },
};

const APPLE_EYES: Record<AlicePose, string> = {
  default: ' ▗   ▖ ',
  'look-left': ' ▘   ▘ ',
  'look-right': ' ▝   ▝ ',
  'arms-up': ' ▗   ▖ ',
};

export function AliceMascot({ pose = 'default' }: Props = {}): React.ReactNode {
  if (env.terminal === 'Apple_Terminal') {
    return <AppleTerminalAlice pose={pose} />;
  }
  const p = POSES[pose];
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="mascot_body">{p.r1L}</Text>
        <Text color="mascot_body" backgroundColor="mascot_background">
          {p.r1E}
        </Text>
        <Text color="mascot_body">{p.r1R}</Text>
      </Text>
      <Text>
        <Text color="mascot_body">{p.r2L}</Text>
        <Text color="mascot_body" backgroundColor="mascot_background">
          █████
        </Text>
        <Text color="mascot_body">{p.r2R}</Text>
      </Text>
      <Text color="mascot_body">
        {'  '}▘▘ ▝▝{'  '}
      </Text>
    </Box>
  );
}

function AppleTerminalAlice({ pose }: { pose: AlicePose }): React.ReactNode {
  return (
    <Box flexDirection="column" alignItems="center">
      <Text>
        <Text color="mascot_body">▗</Text>
        <Text color="mascot_background" backgroundColor="mascot_body">
          {APPLE_EYES[pose]}
        </Text>
        <Text color="mascot_body">▖</Text>
      </Text>
      <Text backgroundColor="mascot_body">{' '.repeat(7)}</Text>
      <Text color="mascot_body">▘▘ ▝▝</Text>
    </Box>
  );
}
