import { flushSync } from 'react-dom';
import { prepareWebDavSync, acceptWebDavSync } from '@/features/webdav/services/webdav';
import { useMountedState } from 'react-use';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import type { SetSession, UnlockSession } from '@/features/unlock/services/session';
import { syncSession } from '@/features/workspace/services/session';

type UseSyncProps = UnlockSession & {
  busy?: boolean;
  isBusyNow?: () => boolean;
  onWebDavApply?: (applying: boolean) => void;
  setSession: SetSession;
};

type State = {
  loading: boolean;
  error?: Error;
};

const useWebDavSync = (props: UseSyncProps) => {
  const { record, version, webDav, webDavError, busy = false } = props;
  const current = useRef(props);
  useLayoutEffect(() => {
    current.current = props;
  });
  const pass = useRef<AbortController | null>(null);
  const running = useRef(false);
  const deferred = useRef(false);
  const [state, set] = useState<State>({ loading: false, error: webDavError });
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
    const connection = captured.webDav;
    if (captured.record.type !== 'webdav' || !connection || connection.signal.aborted) return;
    if (running.current || captured.isBusyNow?.()) {
      deferred.current = true;
      return;
    }
    deferred.current = false;
    running.current = true;
    const controller = new AbortController();
    pass.current = controller;
    const signal = AbortSignal.any([controller.signal, connection.signal]);
    const canApply = () =>
      mounted.current &&
      !signal.aborted &&
      current.current.webDav === connection &&
      current.current.record.id === captured.record.id &&
      current.current.version === captured.version &&
      !current.current.isBusyNow?.();
    set({ loading: true });
    void (async () => {
      try {
        const prepared = await prepareWebDavSync({
          id: captured.record.id,
          connection,
          credentials: captured.database.credentials,
          signal,
          canApply,
        });
        if (!canApply()) {
          deferred.current = true;
          return;
        }
        flushSync(() => captured.onWebDavApply?.(true));
        if (!canApply()) {
          deferred.current = true;
          return;
        }
        const result = await acceptWebDavSync(prepared, signal, canApply);
        if (result.status === 'missing')
          throw new Error('The WebDAV database was removed. Download your database before closing.');
        if (result.status === 'superseded') {
          deferred.current = true;
          return;
        }
        if (!canApply()) return;
        flushSync(() =>
          captured.setSession((previous) => {
            if (
              !previous ||
              previous.record.id !== captured.record.id ||
              previous.webDav !== connection ||
              previous.version !== captured.version ||
              !canApply()
            )
              return previous;
            return { ...previous, database: prepared.database, record: result.record };
          }),
        );
        if (mounted.current) set({ loading: false });
      } catch (error) {
        if (!mounted.current || connection.signal.aborted) return;
        if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
          deferred.current = true;
          set({ loading: false });
        } else {
          deferred.current = false;
          set({ loading: false, error: error instanceof Error ? error : new Error('WebDAV sync failed.') });
        }
      } finally {
        if (mounted.current) flushSync(() => captured.onWebDavApply?.(false));
        if (pass.current === controller) pass.current = null;
        running.current = false;
        if (
          deferred.current &&
          mounted.current &&
          current.current.webDav === connection &&
          !connection.signal.aborted &&
          !current.current.isBusyNow?.()
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

  const handleWebDavVersion = useEffectEvent(() => {
    if (record.type !== 'webdav') return;
    if (!webDavError && !state.error) trigger();
  });
  useEffect(() => {
    handleWebDavVersion();
  }, [record.id, version, webDav, wake]);

  const handleWebDavBusy = useEffectEvent(() => {
    if (!busy && deferred.current && !state.error) trigger();
  });
  useEffect(() => {
    handleWebDavBusy();
  }, [busy]);

  const retrySync = () => {
    if (!state.error) return;
    if (webDavError) {
      set({ loading: false, error: webDavError });
      return;
    }
    set({ loading: false });
    setWake((value) => value + 1);
  };

  return { ...state, error: webDavError ?? state.error, retrySync };
};

export const useSync = (props: UseSyncProps) => {
  const { record, database, version, setSession } = props;
  const webDavState = useWebDavSync(props);
  const lastCallId = useRef(0);
  const isMounted = useMountedState();
  const [state, set] = useState<State>({ loading: false });

  const sync = async () => {
    const syncedSession = await syncSession({ record, database });

    setSession((previousSession) => {
      if (!previousSession) {
        return previousSession;
      }

      if (previousSession.version !== version) {
        return previousSession;
      }

      return {
        ...syncedSession,
        version,
      };
    });
  };

  const triggerSync = () => {
    if (record.type === 'webdav') return;
    const callId = ++lastCallId.current;

    if (!state.loading) {
      set({ error: undefined, loading: true });
    }

    void sync()
      .then(() => {
        if (isMounted() && callId === lastCallId.current) {
          set({ error: undefined, loading: false });
        }
      })
      .catch((error) => {
        if (isMounted() && callId === lastCallId.current) {
          set({ error, loading: false });
        }
      });
  };

  const retrySync = () => {
    // if an error was received, then we disable auto syncing
    if (!state.error) {
      return;
    }

    triggerSync();
  };

  const handleVersionSync = useEffectEvent(() => {
    // if an error was received, then we disable auto syncing
    if (state.error) {
      return;
    }

    triggerSync();
  });

  useEffect(() => {
    // syncing on every version change is the point of this effect, and `loading` tracks that sync
    // eslint-disable-next-line react-hooks/set-state-in-effect
    handleVersionSync();
  }, [version]);

  return record.type === 'webdav' ? webDavState : { ...state, retrySync };
};
