import { flushSync } from 'react-dom';
import { useSafeNet } from '@/features/workspace/hooks/use-safe-net';
import { useEntryMutation } from '@/features/workspace/hooks/use-entry-mutation';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import type { SetSession, UnlockSession } from '@/features/unlock/services/session';
import { syncSession } from '@/features/workspace/services/session';

type UseSyncProps = UnlockSession & {
  onSyncApply?: (applying: boolean) => void;
  setSession: SetSession;
};

type State = {
  loading: boolean;
  error?: Error;
};

export const useSync = (props: UseSyncProps) => {
  const { record, version, connection } = props;
  const { isDirty, isDirtyNow } = useSafeNet();
  const { isMutating, isMutatingNow } = useEntryMutation();
  const busy = isDirty || isMutating;
  const isBusyNow = () => isDirtyNow() || isMutatingNow();
  const current = useRef({ ...props, isBusyNow });
  useLayoutEffect(() => {
    current.current = { ...props, isBusyNow };
  });
  const pass = useRef<AbortController | null>(null);
  const running = useRef(false);
  const deferred = useRef(false);
  const [state, set] = useState<State>({ loading: true });
  const [wake, setWake] = useState(0);
  const mounted = useRef(true);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pass.current?.abort();
    };
  }, []);

  const trigger = useEffectEvent(() => {
    const captured = current.current;
    const connection = captured.connection;
    if (connection?.signal.aborted) return;
    if (running.current || captured.isBusyNow()) {
      deferred.current = true;
      return;
    }
    deferred.current = false;
    running.current = true;
    const controller = new AbortController();
    pass.current = controller;
    const signal = connection ? AbortSignal.any([controller.signal, connection.signal]) : controller.signal;
    const canApply = () =>
      mounted.current &&
      !signal.aborted &&
      current.current.database.credentials === captured.database.credentials &&
      current.current.record.id === captured.record.id &&
      current.current.version === captured.version &&
      !current.current.isBusyNow();
    set({ loading: true });
    void (async () => {
      try {
        const result = await syncSession({
          ...captured,
          signal,
          canApply,
          onApply: () => flushSync(() => captured.onSyncApply?.(true)),
        });
        if (!canApply()) return;
        flushSync(() =>
          captured.setSession((previous) => {
            if (
              !previous ||
              previous.record.id !== captured.record.id ||
              previous.database.credentials !== captured.database.credentials ||
              previous.version !== captured.version ||
              !canApply()
            )
              return previous;
            return { ...previous, ...result };
          }),
        );
        if (mounted.current) set({ loading: false });
      } catch (error) {
        if (!mounted.current || connection?.signal.aborted) return;
        if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
          deferred.current = true;
          set({ loading: true });
        } else {
          deferred.current = false;
          set({ loading: false, error: error instanceof Error ? error : new Error('Sync failed.') });
        }
      } finally {
        if (mounted.current) flushSync(() => captured.onSyncApply?.(false));
        if (pass.current === controller) pass.current = null;
        running.current = false;
        if (
          deferred.current &&
          mounted.current &&
          current.current.database.credentials === captured.database.credentials &&
          !connection?.signal.aborted &&
          !current.current.isBusyNow()
        )
          setWake((value) => value + 1);
      }
    })();
  });

  useLayoutEffect(() => {
    if (busy && running.current) {
      deferred.current = true;
      pass.current?.abort();
    }
  }, [busy]);

  const handleVersion = useEffectEvent(() => {
    if (!state.error) trigger();
  });
  useEffect(() => {
    handleVersion();
  }, [record.id, version, connection, wake]);

  const handleBusy = useEffectEvent(() => {
    if (!busy && deferred.current && !state.error) trigger();
  });
  useEffect(() => {
    handleBusy();
  }, [busy]);

  const retrySync = () => {
    if (!state.error) return;
    set({ loading: true });
    setWake((value) => value + 1);
  };

  return { ...state, retrySync };
};
