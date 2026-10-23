import type kdbxweb from '@/utils/kdbxweb';
import { useEffect, useState, type SyntheticEvent } from 'react';
import { type SetSession, type UnlockSession } from '@/features/unlock/services/session';
import {
  createEntry,
  findEntryByUuid,
  type EntryMutationResult,
  type SelectFilter,
} from '@/features/workspace/services/entry';
import { MenuPane } from '@/features/workspace/components/menu-pane';
import { EntryList } from '@/features/workspace/components/entry-list';
import { EntryDetails } from '@/features/workspace/components/entry-details';
import { WorkspaceControls } from '@/features/workspace/components/workspace-controls';
import { WorkspaceMobileMenu } from '@/features/workspace/components/workspace-mobile-menu';
import { toast } from 'sonner';
import { useMedia } from 'react-use';
import { getErrorMessage } from '@/utils/error';
import { useIdleLock } from '@/features/workspace/hooks/use-idle-lock';
import { useSafeNet } from '@/features/workspace/hooks/use-safe-net';
import { useEntryMutation } from '@/features/workspace/hooks/use-entry-mutation';

type WorkspacePageProps = {
  session: UnlockSession;
  setSession: SetSession;
};

export const WorkspacePage = ({ session, setSession }: WorkspacePageProps) => {
  const { database, record, connection } = session;
  const [isApplyingSync, setApplyingSync] = useState(false);
  useEffect(() => () => connection?.dispose(), [connection]);
  const [selectFilter, setSelectFilter] = useState<SelectFilter>(null);
  const [selectedEntryUuid, setSelectedEntryUuid] = useState<kdbxweb.KdbxUuid | null>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const isMobile = useMedia('(max-width: 768px)');
  const { guardNavigation } = useSafeNet();
  const { setMutating } = useEntryMutation();

  const blockSyncEditing = isApplyingSync
    ? (event: SyntheticEvent) => {
        event.preventDefault();
        event.stopPropagation();
      }
    : undefined;

  const selectedEntry = selectedEntryUuid ? findEntryByUuid(database, selectedEntryUuid) : null;

  const handleSelectEntry = (uuid: kdbxweb.KdbxUuid) => {
    if (isApplyingSync) return;
    guardNavigation(() => setSelectedEntryUuid(uuid));
  };

  const handleSelectFilterChange = (nextSelectFilter: SelectFilter) => {
    if (isApplyingSync) return;
    guardNavigation(() => {
      setSelectFilter(nextSelectFilter);
      setSelectedEntryUuid(null);
      setIsMobileMenuOpen(false);
    });
  };

  const handleBack = () => guardNavigation(() => setSelectedEntryUuid(null));

  const handleSave = ({ nextDatabase, nextEntryUuid, nextRecord }: EntryMutationResult) => {
    setSession((previousSession) => {
      if (!previousSession) return previousSession;
      if (connection?.signal.aborted || previousSession.database.credentials !== database.credentials)
        return previousSession;

      return {
        ...previousSession,
        database: nextDatabase,
        record: nextRecord,
        version: previousSession.version + 1,
      };
    });

    setSelectedEntryUuid(nextEntryUuid);
  };

  const onWorkspaceLock = () => {
    connection?.dispose();
    setSession(null);
    setSelectedEntryUuid(null);
    setIsMobileMenuOpen(false);
  };

  // idle lock must not be blockable by a dirty form, so it bypasses guardNavigation on purpose
  useIdleLock({ onWorkspaceLock });

  const handleLock = () => guardNavigation(onWorkspaceLock);

  const createNewEntry = async () => {
    setMutating(true);
    try {
      const result = await createEntry({ database, record, selectFilter, signal: connection?.signal });
      connection?.signal.throwIfAborted();
      handleSave(result);
      toast.success('Entry created.');
    } catch (error) {
      if (!connection?.signal.aborted) toast.error(getErrorMessage({ error, fallback: 'Entry creation failed.' }));
    } finally {
      setMutating(false);
    }
  };

  const handleCreateEntry = () => {
    if (isApplyingSync) return;
    guardNavigation(() => void createNewEntry());
  };

  const isDesktopMode = !isMobile;
  const showListPane = isDesktopMode || !selectedEntryUuid;
  const showDetailsPane = isDesktopMode || Boolean(selectedEntryUuid);

  return (
    <div className="box-border flex h-svh min-h-svh flex-col overflow-hidden bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground sm:h-dvh sm:min-h-dvh sm:py-0">
      <WorkspaceControls
        session={session}
        setSession={setSession}
        onWorkspaceLock={handleLock}
        onSyncApply={setApplyingSync}
      />
      <div
        inert={isApplyingSync}
        onClickCapture={blockSyncEditing}
        onKeyDownCapture={blockSyncEditing}
        onBeforeInputCapture={blockSyncEditing}
        className="flex min-h-0 flex-1 overflow-hidden"
      >
        {isDesktopMode && (
          <MenuPane
            className="flex"
            database={database}
            onSelectFilterChange={handleSelectFilterChange}
            selectFilter={selectFilter}
          />
        )}
        {showListPane && (
          <EntryList
            className={isMobile ? 'flex w-full border-r-0' : 'flex'}
            database={database}
            onEntryCreate={handleCreateEntry}
            onEntrySelect={handleSelectEntry}
            selectFilter={selectFilter}
            selectedEntryUuid={selectedEntryUuid}
            showMenuButton={isMobile}
            onMenuOpen={() => setIsMobileMenuOpen(true)}
          />
        )}
        {showDetailsPane && (
          <EntryDetails
            className={isMobile ? 'flex w-full' : 'flex'}
            selectedEntry={selectedEntry}
            database={database}
            record={record}
            signal={connection?.signal}
            onEntrySave={handleSave}
            showBackButton={isMobile}
            onBack={handleBack}
          />
        )}
      </div>
      {isMobile && (
        <WorkspaceMobileMenu
          open={isMobile && isMobileMenuOpen}
          onOpenChange={setIsMobileMenuOpen}
          database={database}
          onSelectFilterChange={handleSelectFilterChange}
          selectFilter={selectFilter}
        />
      )}
    </div>
  );
};
