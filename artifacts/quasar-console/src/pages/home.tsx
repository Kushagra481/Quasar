import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Activity, AlertCircle, ArrowDownRight, ArrowRight, ArrowUpRight, Check,
  CheckCircle2, ChevronDown, CircleDot, Clock3, Command, Cpu, Database,
  FileCode2, GitBranch, HardDrive, Info, Layers3, LoaderCircle, Play,
  RefreshCw, Shield, ShieldCheck, Sparkles, XCircle,
} from 'lucide-react';
import {
  getGetQuasarRunQueryKey, getListQuasarRunsQueryKey, useGetQuasarRun,
  useGetQuasarStatus, useHealthCheck, useListQuasarRuns, useRunQuasarDemo,
} from '@workspace/api-client-react';
import type { QuasarRun } from '@workspace/api-client-react';

type Fault = 'crash' | 'resource' | 'regression' | 'dependency';
type AnyRecord = Record<string, unknown>;

const faultOptions: { id: Fault; label: string; detail: string; code: string }[] = [
  { id: 'crash', label: 'Service crash', detail: 'A service stops responding', code: 'F-01' },
  { id: 'resource', label: 'Resource pressure', detail: 'CPU or memory exhaustion', code: 'F-02' },
  { id: 'regression', label: 'Release regression', detail: 'A recent change degrades health', code: 'F-03' },
  { id: 'dependency', label: 'Dependency failure', detail: 'An upstream service is unavailable', code: 'F-04' },
];

function record(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {};
}
function display(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'Not reported';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2) ?? String(value);
}
function keyLabel(value: string) {
  return value.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').replace(/^./, (s) => s.toUpperCase());
}
function dateLabel(value: unknown) {
  if (!value) return 'Time unavailable';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function statusTone(value: unknown) {
  const status = String(value ?? '').toLowerCase();
  if (['resolved', 'healthy', 'ok', 'ready', 'success'].some((term) => status.includes(term))) return 'good';
  if (['failed', 'error', 'offline', 'unhealthy'].some((term) => status.includes(term))) return 'bad';
  return 'neutral';
}
function StatusPill({ value }: { value: unknown }) {
  const tone = statusTone(value);
  return <span className={`status-pill ${tone}`}><span className="pill-dot" />{display(value)}</span>;
}
function Skeleton({ lines = 3 }: { lines?: number }) {
  return <div className="skeleton-stack" aria-label="Loading">
    {Array.from({ length: lines }, (_, i) => <span className={`skeleton skeleton-${i % 3}`} key={i} />)}
  </div>;
}
function ValueGrid({ value, empty }: { value: unknown; empty: string }) {
  const entries = Object.entries(record(value));
  if (!entries.length) return <p className="quiet-copy">{empty}</p>;
  return <div className="value-grid">{entries.map(([key, item]) =>
    <div className="value-item" key={key}><span>{keyLabel(key)}</span><strong>{display(item)}</strong></div>,
  )}</div>;
}
function RunStatusIcon({ status }: { status: unknown }) {
  const tone = statusTone(status);
  if (tone === 'good') return <CheckCircle2 size={15} />;
  if (tone === 'bad') return <XCircle size={15} />;
  return <CircleDot size={15} />;
}

export default function Home() {
  const queryClient = useQueryClient();
  const statusQuery = useGetQuasarStatus();
  const healthQuery = useHealthCheck();
  const runsQuery = useListQuasarRuns();
  const runMutation = useRunQuasarDemo();
  const [fault, setFault] = useState<Fault>('crash');
  const [apply, setApply] = useState(false);
  const [allowRollback, setAllowRollback] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const runs = useMemo(() => Array.isArray(runsQuery.data) ? runsQuery.data as QuasarRun[] : [], [runsQuery.data]);
  useEffect(() => {
    if (!selectedId && runs.length) setSelectedId(runs[0].id);
    if (selectedId && !runs.some((run) => run.id === selectedId) && runs.length) setSelectedId(runs[0].id);
  }, [runs, selectedId]);

  const runQuery = useGetQuasarRun(selectedId ?? '', {
    query: { enabled: !!selectedId, queryKey: getGetQuasarRunQueryKey(selectedId ?? '') },
  });
  const status = record(statusQuery.data);
  const selectedRun = runQuery.data ?? runs.find((run) => run.id === selectedId);
  const capabilities = [
    { label: 'Reasoning', value: status.reasoner ?? status.diagnosisProvider, icon: Sparkles },
    { label: 'Policy', value: status.policy, icon: Shield },
    { label: 'Actions', value: status.actions, icon: Activity },
    { label: 'Graph', value: status.graph, icon: GitBranch },
  ];
  const runDemo = () => runMutation.mutate({ data: { fault, apply, allowRollback } }, {
    onSuccess: (run) => {
      setSelectedId(run.id);
      queryClient.invalidateQueries({ queryKey: getListQuasarRunsQueryKey() });
      queryClient.setQueryData(getGetQuasarRunQueryKey(run.id), run);
    },
  });

  return <div className="app-shell">
    <aside className="rail">
      <div className="brand-lockup">
        <div className="brand-mark"><span /><span /><span /></div>
        <div><strong>QUASAR</strong><small>CONSOLE</small></div>
      </div>
      <div className="rail-divider" />
      <div className="rail-label">WORKSPACE</div>
       <a className="rail-link active" href={import.meta.env.BASE_URL} data-testid="nav-overview"><Activity size={16} /><span>Overview</span><span className="rail-active-dot" /></a>
      <a className="rail-link" href="#runs"><Layers3 size={16} /><span>Demo runs</span></a>
      <a className="rail-link" href="#capabilities"><ShieldCheck size={16} /><span>Capabilities</span></a>
      <div className="rail-foot">
        <div className="rail-divider" />
        <div className="mode-card">
          <div className="mode-symbol"><ShieldCheck size={15} /></div>
          <strong>Sandbox mode</strong>
          <p>Local synthetic incidents only. No live infrastructure access.</p>
          <span className="mode-status"><i /> ISOLATED</span>
        </div>
        <div className="rail-build">QUASAR FRAMEWORK <span>{display(status.version ?? '—')}</span></div>
      </div>
    </aside>

    <main className="main-area">
      <header className="topbar">
        <div className="breadcrumbs"><span>WORKSPACE</span><ArrowRight size={13} /><strong>Overview</strong></div>
        <div className="topbar-right">
          <span className="environment"><span className="env-dot" /> SYNTHETIC ENVIRONMENT</span>
          <span className="topbar-separator" />
          <button className="icon-button" aria-label="Refresh status" data-testid="button-refresh" onClick={() => { void statusQuery.refetch(); void healthQuery.refetch(); void runsQuery.refetch(); }}><RefreshCw size={15} /></button>
          <span className="operator-avatar">OP</span>
        </div>
      </header>

      <div className="page-content" id="top">
        <section className="page-heading">
          <div>
            <div className="eyebrow"><span className="eyebrow-line" /> OPERATIONS / LOCAL API</div>
            <h1>Quasar <span>workbench</span></h1>
            <p>Run a contained incident, then inspect every decision and recovery step.</p>
          </div>
          <div className="health-summary">
            <div className="health-icon"><Activity size={17} /></div>
            <div><span>API HEALTH</span><strong>{healthQuery.isLoading ? 'Checking…' : display(record(healthQuery.data).status ?? 'Unknown')}</strong></div>
            {healthQuery.isLoading ? <LoaderCircle className="spin" size={15} /> : <StatusPill value={record(healthQuery.data).status ?? 'unknown'} />}
          </div>
        </section>

        <section className="safety-banner" aria-label="Synthetic demo notice">
          <div className="banner-icon"><ShieldCheck size={17} /></div>
          <div className="banner-copy"><strong>Safe by design. Synthetic by default.</strong><span>These demos use an offline reasoner and local simulated services. This API cannot reach live infrastructure or Gemini.</span></div>
          <span className="banner-tag">NO LIVE MUTATIONS</span>
        </section>

        <div className="workspace-grid">
          <section className="panel demo-panel">
            <div className="panel-heading">
              <div><div className="section-kicker">01 / SIMULATE</div><h2>Run an incident demo</h2></div>
              <span className="local-tag"><span /> LOCAL</span>
            </div>
            <p className="panel-intro">Choose a fault to inject into the sandbox. No production systems are touched.</p>
            <div className="field-label">INCIDENT TYPE</div>
            <div className="fault-options">
              {faultOptions.map((item) => <button
                key={item.id}
                onClick={() => setFault(item.id)}
                className={`fault-option ${fault === item.id ? 'selected' : ''}`}
                data-testid={`select-fault-${item.id}`}
                aria-pressed={fault === item.id}
              >
                <span className="fault-radio">{fault === item.id && <span />}</span>
                <span className="fault-text"><strong>{item.label}</strong><small>{item.detail}</small></span>
                <span className="fault-code">{item.code}</span>
              </button>)}
            </div>
            <div className="options-divider" />
            <div className="option-row">
              <div className="option-icon"><Play size={14} /></div>
              <div className="option-copy"><strong>Apply proposed action</strong><span>Execute recovery in the simulated environment</span></div>
              <button className={`switch ${apply ? 'on' : ''}`} role="switch" aria-checked={apply} aria-label="Apply proposed action" data-testid="toggle-apply" onClick={() => setApply(!apply)}><span /></button>
            </div>
            <div className="option-row">
              <div className="option-icon rollback"><ArrowDownRight size={14} /></div>
              <div className="option-copy"><strong>Allow rollback</strong><span>Permit automatic recovery rollback if needed</span></div>
              <button className={`switch ${allowRollback ? 'on' : ''}`} role="switch" aria-checked={allowRollback} aria-label="Allow rollback" data-testid="toggle-rollback" onClick={() => setAllowRollback(!allowRollback)}><span /></button>
            </div>
            <button className="run-button" onClick={runDemo} disabled={runMutation.isPending} data-testid="button-run-demo">
              {runMutation.isPending ? <><LoaderCircle size={16} className="spin" /> Running contained demo…</> : <><Play size={15} fill="currentColor" /> Run synthetic demo <ArrowRight size={15} /></>}
            </button>
            {runMutation.isError && <div className="inline-error" role="alert"><AlertCircle size={15} /><span>Demo could not run. Check API availability and try again.</span><button onClick={runDemo} data-testid="button-retry-demo">Retry</button></div>}
            <div className="demo-footnote"><Info size={13} /> Every run is persisted with its audit trail for review.</div>
          </section>

          <section className="panel system-panel" id="capabilities">
            <div className="panel-heading">
              <div><div className="section-kicker">02 / FRAMEWORK</div><h2>Runtime status</h2></div>
              <button className="text-button" onClick={() => { void statusQuery.refetch(); }} data-testid="button-refresh-runtime"><RefreshCw size={13} /> Refresh</button>
            </div>
            {statusQuery.isLoading ? <Skeleton lines={5} /> : statusQuery.isError ? <div className="query-error"><AlertCircle size={16} /><div><strong>Unable to load framework status</strong><span>The API did not return a status response.</span></div><button onClick={() => void statusQuery.refetch()} data-testid="button-retry-status">Retry</button></div> : <>
              <div className="runtime-banner">
                <div className="runtime-orbit"><Cpu size={19} /></div>
                <div><span>FRAMEWORK</span><strong>{display(status.framework ?? 'Quasar')}</strong></div>
                <span className="runtime-version">v{display(status.version ?? '—')}</span>
                <StatusPill value={status.status ?? 'available'} />
              </div>
              <div className="capability-list">
                {capabilities.map(({ label, value, icon: Icon }) => <div className="capability-row" key={label}>
                  <span className="capability-icon"><Icon size={14} /></span><span className="capability-label">{label}</span>
                  <strong>{display(value)}</strong>
                </div>)}
              </div>
              <div className="runtime-meta">
                <div><span>API MODE</span><strong>{display(status.apiMode)}</strong></div>
                <div><span>DATASET</span><strong>{display(status.datasetStatus)}</strong></div>
                <div><span>LIVE ADAPTERS</span><strong>{display(status.liveAdapters)}</strong></div>
                <div><span>LIVE ACCESS</span><strong>{display(status.liveAdapterAccess)}</strong></div>
              </div>
              <details className="status-details">
                <summary data-testid="summary-runtime-details"><span><Command size={14} /> Defaults &amp; commands</span><ChevronDown size={14} /></summary>
                <ValueGrid value={{ defaults: status.defaults, commands: status.commands }} empty="No additional runtime configuration reported." />
              </details>
            </>}
          </section>
        </div>

        <section className="runs-section" id="runs">
          <div className="runs-heading">
            <div><div className="section-kicker">03 / AUDIT LOG</div><h2>Demo runs <span className="run-count">{runs.length}</span></h2></div>
            <div className="runs-meta"><Database size={14} /> Persisted local API history</div>
          </div>
          <div className="runs-layout">
            <div className="run-list panel">
              <div className="list-topline"><span>RECENT ACTIVITY</span><button className="icon-button small" aria-label="Refresh demo runs" onClick={() => void runsQuery.refetch()} data-testid="button-refresh-runs"><RefreshCw size={13} /></button></div>
              {runsQuery.isLoading ? <Skeleton lines={4} /> : runsQuery.isError ? <div className="empty-state"><AlertCircle size={18} /><strong>History unavailable</strong><span>Could not load persisted demo runs.</span><button onClick={() => void runsQuery.refetch()} data-testid="button-retry-runs">Try again</button></div> : runs.length === 0 ? <div className="empty-state"><div className="empty-mark"><HardDrive size={18} /></div><strong>No demos run yet</strong><span>Your synthetic incident history will appear here.</span></div> :
                runs.map((run) => <button
                  key={run.id}
                  onClick={() => setSelectedId(run.id)}
                  className={`run-row ${selectedId === run.id ? 'current' : ''}`}
                  data-testid={`select-run-${run.id}`}
                >
                  <span className={`run-status-mark ${statusTone(run.status)}`}><RunStatusIcon status={run.status} /></span>
                  <span className="run-row-content"><strong>{run.id}</strong><small>{dateLabel(run.createdAt ?? run.startedAt ?? run.timestamp)}</small></span>
                  <span className="run-row-trailing"><StatusPill value={run.status} /><ArrowRight size={13} /></span>
                </button>)}
              <div className="list-footer"><span><span className="small-dot" /> LOCAL RECORDS</span><span>{runs.length} {runs.length === 1 ? 'run' : 'runs'}</span></div>
            </div>

            <div className="audit-panel panel">
              {!selectedId && !runsQuery.isLoading ? <div className="audit-empty"><div className="empty-mark large"><FileCode2 size={21} /></div><div className="section-kicker">AUDIT TRAIL</div><h3>Nothing selected</h3><p>Run a synthetic demo or choose a persisted run to inspect its exact actions and outcome.</p></div> :
                runQuery.isLoading ? <div className="audit-loading"><Skeleton lines={7} /></div> :
                runQuery.isError ? <div className="query-error"><AlertCircle size={16} /><div><strong>Unable to load this audit trail</strong><span>Run details could not be retrieved.</span></div><button onClick={() => void runQuery.refetch()} data-testid="button-retry-detail">Retry</button></div> :
                selectedRun ? <AuditDetail run={record(selectedRun)} /> : <div className="audit-loading"><Skeleton lines={5} /></div>}
            </div>
          </div>
        </section>

        <footer className="page-footer"><span>QUASAR CONSOLE <i>·</i> OPERATOR WORKBENCH</span><span><ShieldCheck size={13} /> Synthetic-only API boundary <ArrowUpRight size={12} /></span></footer>
      </div>
    </main>
  </div>;
}

function AuditDetail({ run }: { run: AnyRecord }) {
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const diagnosis = record(run.diagnosis);
  const proposed = typeof run.proposedAction === 'string' ? { action: run.proposedAction } : record(run.proposedAction);
  const before = run.before ?? run.beforeSnapshot;
  const after = run.after ?? run.afterSnapshot;
  return <div className="audit-detail">
    <div className="audit-title-row">
      <div><div className="section-kicker">AUDIT TRAIL / {String(run.id)}</div><h3>Run inspection</h3></div>
      <StatusPill value={run.status} />
    </div>
    <div className="audit-stats">
      <div><span>ADAPTER</span><strong>{display(run.adapter)}</strong></div>
      <div><span>REASONER</span><strong>{display(run.reasoner)}</strong></div>
      <div><span>POLICY VERSION</span><strong>{display(run.policyVersion)}</strong></div>
      <div><span>DURATION</span><strong>{typeof run.durationMs === 'number' ? `${run.durationMs} ms` : display(run.durationMs)}</strong></div>
      <div><span>MUTATIONS</span><strong>{display(run.mutations)}</strong></div>
      <div><span>REWARD</span><strong>{display(run.reward)}</strong></div>
    </div>
    {(run.error !== undefined && run.error !== null) && <div className="run-error"><AlertCircle size={15} /><div><strong>Run error</strong><span>{display(run.error)}</span></div></div>}
    <div className="audit-columns">
      <div className="audit-subsection">
        <div className="subsection-heading"><Sparkles size={14} /><h4>Diagnosis</h4></div>
        <ValueGrid value={diagnosis} empty="No diagnosis details were reported." />
      </div>
      <div className="audit-subsection">
        <div className="subsection-heading"><ShieldCheck size={14} /><h4>Proposed action</h4></div>
        <ValueGrid value={proposed} empty="No proposed action was reported." />
      </div>
    </div>
    <div className="audit-subsection snapshot-section">
      <div className="subsection-heading"><Layers3 size={14} /><h4>Environment snapshots</h4></div>
      <div className="snapshot-grid"><div className="snapshot before"><div><span className="snapshot-dot" /> BEFORE</div><pre>{before === undefined ? 'No snapshot recorded.' : display(before)}</pre></div><div className="snapshot after"><div><span className="snapshot-dot" /> AFTER</div><pre>{after === undefined ? 'No snapshot recorded.' : display(after)}</pre></div></div>
    </div>
    <div className="audit-subsection steps-section">
      <div className="subsection-heading"><GitBranch size={14} /><h4>Execution steps</h4><span className="step-count">{steps.length}</span></div>
      {steps.length ? <ol className="step-list">{steps.map((step, index) => {
        const item = record(step);
        const title = item.node ?? item.name ?? item.action ?? item.step ?? item.type ?? `Step ${index + 1}`;
        return <li key={`${index}-${String(title)}`}><span className="step-number">{String(index + 1).padStart(2, '0')}</span><div className="step-body"><strong>{display(title)}</strong><span>{display(item.message ?? item.status ?? item.result ?? item.description ?? step)}</span></div><Check size={13} className="step-check" /></li>;
      })}</ol> : <p className="quiet-copy">No execution steps were reported for this run.</p>}
    </div>
    <div className="audit-timestamp"><Clock3 size={13} /> Recorded {dateLabel(run.createdAt ?? run.startedAt ?? run.timestamp)}</div>
  </div>;
}