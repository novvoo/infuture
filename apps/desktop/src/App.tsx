import React from 'react';
import { AppProvider, useAppApi, useAppState } from './state';
import { ActivityRail } from './components/ActivityRail';
import { SidebarPanel } from './components/SidebarPanel';
import { MessageLog } from './components/MessageLog';
import { Composer } from './components/Composer';
import { FilesPanel } from './components/FilesPanel';
import { InspectorPanel } from './components/InspectorPanel';
import { ApprovalCapsule } from './components/ApprovalCapsule';
import { GoalsPanel } from './components/GoalsPanel';
import { SettingsView } from './components/SettingsView';
import { LocalModelsPanel } from './components/LocalModelsPanel';
import { StatusBar } from './components/StatusBar';
import { BrowserPreviewFloat } from './components/BrowserPreviewFloat';

function Workbench() {
  const { view } = useAppState();
  const { setView } = useAppApi();

  return (
    <div className="workbench">
      <div className="workbench-row">
        <ActivityRail view={view} onView={setView} />
        {/* 会话列表只在 chat 视图需要；files/runs/workers/settings 用完整宽度 */}
        {view === 'chat' && <SidebarPanel />}
        <main className="main">
          {view === 'files' ? (
            <FilesPanel />
          ) : view === 'workers' ? (
            <GoalsPanel />
          ) : view === 'local' ? (
            <LocalModelsPanel />
          ) : view === 'settings' ? (
            <SettingsView />
          ) : (
            <section className="chat-workspace">
              <MessageLog />
              <Composer />
            </section>
          )}
        </main>
        <InspectorPanel />
      </div>
      <StatusBar />
      <ApprovalCapsule />
      <BrowserPreviewFloat />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Workbench />
    </AppProvider>
  );
}
