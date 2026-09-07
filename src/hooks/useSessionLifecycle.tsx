import { feature } from 'bun:bundle';
import { spawnSync } from 'child_process';
import * as React from 'react';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useStdin } from '@anthropic/ink';
import type { AutoUpdaterResult } from '../utils/autoUpdater.js';
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js';
import { hasConsoleBillingAccess } from '../utils/billing.js';
import { getTotalCost } from '../cost-tracker.js';
import { logEvent } from 'src/services/analytics/index.js';
import { isBgSession } from '../utils/concurrentSessions.js';
import { getCurrentWorktreeSession } from '../utils/worktree.js';
import exit from '../commands/exit/index.js';
import { ExitFlow } from '../components/ExitFlow.js';
import type { Notification } from '../context/notifications.js';
import type { Message as MessageType } from '../types/message.js';

export interface SessionLifecycleParams {
  messages: MessageType[];
  addNotification: (notification: Notification) => void;
}

export interface SessionLifecycleState {
  autoUpdaterResult: AutoUpdaterResult | null;
  setAutoUpdaterResult: React.Dispatch<React.SetStateAction<AutoUpdaterResult | null>>;
  exitFlow: React.ReactNode;
  setExitFlow: React.Dispatch<React.SetStateAction<React.ReactNode>>;
  isExiting: boolean;
  setIsExiting: React.Dispatch<React.SetStateAction<boolean>>;
  showCostDialog: boolean;
  setShowCostDialog: React.Dispatch<React.SetStateAction<boolean>>;
  haveShownCostDialog: boolean | undefined;
  setHaveShownCostDialog: React.Dispatch<React.SetStateAction<boolean | undefined>>;
  idleReturnPending: { input: string; idleMinutes: number } | null;
  setIdleReturnPending: React.Dispatch<React.SetStateAction<{ input: string; idleMinutes: number } | null>>;
  skipIdleCheckRef: React.MutableRefObject<boolean>;
  lastQueryCompletionTimeRef: React.MutableRefObject<number>;
  handleExit: () => Promise<void>;
  remountKey: number;
}

export function useSessionLifecycle({ messages, addNotification }: SessionLifecycleParams): SessionLifecycleState {
  // ---- Auto-updater state ----
  const [autoUpdaterResult, setAutoUpdaterResult] = useState<AutoUpdaterResult | null>(null);

  useEffect(() => {
    if (autoUpdaterResult?.notifications) {
      autoUpdaterResult.notifications.forEach(notification => {
        addNotification({
          key: 'auto-updater-notification',
          text: notification,
          priority: 'low',
        });
      });
    }
  }, [autoUpdaterResult, addNotification]);

  // ---- Exit flow state ----
  const [exitFlow, setExitFlow] = useState<React.ReactNode>(null);
  const [isExiting, setIsExiting] = useState(false);

  // ---- Cost dialog state ----
  const [showCostDialog, setShowCostDialog] = useState(false);
  const [haveShownCostDialog, setHaveShownCostDialog] = useState(getGlobalConfig().hasAcknowledgedCostThreshold);

  useEffect(() => {
    const totalCost = getTotalCost();
    if (totalCost >= 5 /* $5 */ && !showCostDialog && !haveShownCostDialog) {
      logEvent('tengu_cost_threshold_reached', {});
      // Mark as shown even if the dialog won't render (no console billing
      // access). Otherwise this effect re-fires on every message change for
      // the rest of the session — 200k+ spurious events observed.
      setHaveShownCostDialog(true);
      if (hasConsoleBillingAccess()) {
        setShowCostDialog(true);
      }
    }
  }, [messages, showCostDialog, haveShownCostDialog]);

  // ---- Idle-return dialog state ----
  const [idleReturnPending, setIdleReturnPending] = useState<{
    input: string;
    idleMinutes: number;
  } | null>(null);
  const skipIdleCheckRef = useRef(false);
  // lastQueryCompletionTimeRef is synced to lastQueryCompletionTime in REPL
  // (the actual lastQueryCompletionTime state stays in REPL since it's used
  // by many other things). This ref allows idle checking without depending
  // on the full lastQueryCompletionTime state chain.
  const lastQueryCompletionTimeRef = useRef(0);

  // ---- Handle exit callback ----
  const handleExit = useCallback(async () => {
    setIsExiting(true);
    // In bg sessions, always detach instead of kill — even when a worktree is
    // active. Without this guard, the worktree branch below short-circuits into
    // ExitFlow (which calls gracefulShutdown) before exit.tsx is ever loaded.
    if (feature('BG_SESSIONS') && isBgSession()) {
      spawnSync('tmux', ['detach-client'], { stdio: 'ignore' });
      setIsExiting(false);
      return;
    }
    const showWorktree = getCurrentWorktreeSession() !== null;
    if (showWorktree) {
      setExitFlow(
        <ExitFlow
          showWorktree
          onDone={() => {}}
          onCancel={() => {
            setExitFlow(null);
            setIsExiting(false);
          }}
        />,
      );
      return;
    }
    const exitMod = await exit.load();
    const exitFlowResult = await exitMod.call(() => {});
    setExitFlow(exitFlowResult);
    // If call() returned without killing the process (bg session detach),
    // clear isExiting so the UI is usable on reattach. No-op on the normal
    // path — gracefulShutdown's process.exit() means we never get here.
    if (exitFlowResult === null) {
      setIsExiting(false);
    }
  }, []);

  // ---- Suspend/resume (Ctrl+Z / fg) ----
  const { internal_eventEmitter } = useStdin();
  const [remountKey, setRemountKey] = useState(0);
  useEffect(() => {
    const handleSuspend = () => {
      // Print suspension instructions
      process.stdout.write(
        `\nClaude Code has been suspended. Run \`fg\` to bring Claude Code back.\nNote: ctrl + z now suspends Claude Code, ctrl + _ undoes input.\n`,
      );
    };

    const handleResume = () => {
      // Force complete component tree replacement instead of terminal clear
      // Ink now handles line count reset internally on SIGCONT
      setRemountKey(prev => prev + 1);
    };

    internal_eventEmitter?.on('suspend', handleSuspend);
    internal_eventEmitter?.on('resume', handleResume);
    return () => {
      internal_eventEmitter?.off('suspend', handleSuspend);
      internal_eventEmitter?.off('resume', handleResume);
    };
  }, [internal_eventEmitter]);

  return {
    autoUpdaterResult,
    setAutoUpdaterResult,
    exitFlow,
    setExitFlow,
    isExiting,
    setIsExiting,
    showCostDialog,
    setShowCostDialog,
    haveShownCostDialog,
    setHaveShownCostDialog,
    idleReturnPending,
    setIdleReturnPending,
    skipIdleCheckRef,
    lastQueryCompletionTimeRef,
    handleExit,
    remountKey,
  };
}
