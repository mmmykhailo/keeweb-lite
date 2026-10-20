import { createContext, useContext, useState, useRef, useCallback, type ReactNode } from 'react';

type EntryMutationContextValue = {
  isMutating: boolean;
  isMutatingNow: () => boolean;
  setMutating: (isMutating: boolean) => void;
};

const EntryMutationContext = createContext<EntryMutationContextValue | null>(null);

export const EntryMutationProvider = ({ children }: { children: ReactNode }) => {
  const [isMutating, setIsMutating] = useState(false);
  const mutationRef = useRef(false);
  const setMutating = useCallback((value: boolean) => {
    mutationRef.current = value;
    setIsMutating(value);
  }, []);
  const isMutatingNow = useCallback(() => mutationRef.current, []);

  return (
    <EntryMutationContext.Provider value={{ isMutating, isMutatingNow, setMutating }}>
      {children}
    </EntryMutationContext.Provider>
  );
};

export const useEntryMutation = () => {
  const context = useContext(EntryMutationContext);

  if (!context) throw new Error('useEntryMutation must be used within an EntryMutationProvider');

  return context;
};
