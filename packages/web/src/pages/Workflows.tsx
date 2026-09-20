/**
 * Workflows page (Phase 4d): no-code visual builder for Phase 2 automation
 * scripts. Blocks serialize to the exact Phase 2 script JSON and are saved
 * through the existing script/version APIs; "Run as job" goes through the
 * existing job API. There is no second execution engine here — this page is
 * only an authoring surface.
 *
 * Permissions: automation:read to view, automation:scripts:manage to save,
 * automation:run to launch jobs.
 */

import { useCallback, useEffect, useState } from 'react';
import { messageOf } from '../api.js';
import type { ApiClient } from '../api.js';
import type {
  AutomationJob,
  AutomationRun,
  AutomationScript,
  IdentityInfo,
  ProfileDetail,
  ScriptVersionNumber,
} from '../types.js';
import { Button, EmptyState, ErrorBanner, Field, Modal, inputClass } from '../ui.js';
import {
  BLOCK_DESCRIPTIONS,
  BLOCK_LABELS,
  BLOCK_TYPES,
  blocksToSteps,
  createBlock,
  moveBlock,
  stepsToBlocks,
  validateBlocks,
  type BlockType,
  type WorkflowBlock,
  type WorkflowBlockFields,
} from '../workflow-blocks.js';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out']);

function hasPermission(identity: IdentityInfo | null, permission: string): boolean {
  return (
    identity !== null &&
    (identity.legacy || identity.isAdmin || identity.permissions.includes(permission))
  );
}

function BlockFieldsEditor({
  block,
  onChange,
}: {
  block: WorkflowBlock;
  onChange: (patch: WorkflowBlockFields) => void;
}): React.JSX.Element {
  const f = block.fields;
  const num = (value: number | undefined): string => (value === undefined ? '' : String(value));
  const setNum = (raw: string): number | undefined => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      return undefined;
    }
    const n = Number(trimmed);
    return Number.isInteger(n) ? n : undefined;
  };

  switch (block.type) {
    case 'navigate':
      return (
        <Field label="URL (http/https/data only)">
          <input
            className={inputClass}
            value={f.url ?? ''}
            onChange={(e) => {
              onChange({ url: e.target.value });
            }}
            inputMode="url"
            placeholder="https://example.com/"
          />
        </Field>
      );
    case 'wait':
      return (
        <Field label="Wait (ms, 1–60000)">
          <input
            className={inputClass}
            type="number"
            min={1}
            max={60000}
            value={num(f.ms)}
            onChange={(e) => {
              const ms = setNum(e.target.value);
              if (ms !== undefined) {
                onChange({ ms });
              }
            }}
          />
        </Field>
      );
    case 'waitForSelector':
    case 'getText':
      return (
        <div className="grid grid-cols-2 gap-2">
          <Field label="CSS selector">
            <input
              className={inputClass}
              value={f.selector ?? ''}
              onChange={(e) => {
                onChange({ selector: e.target.value });
              }}
              placeholder={block.type === 'getText' ? 'h1' : '#main .item'}
            />
          </Field>
          <Field label="Timeout (ms, optional)">
            <input
              className={inputClass}
              type="number"
              min={1}
              max={120000}
              value={num(f.timeoutMs)}
              onChange={(e) => {
                onChange({ timeoutMs: setNum(e.target.value) });
              }}
              placeholder="default"
            />
          </Field>
        </div>
      );
    case 'evaluate':
      return (
        <div className="space-y-2">
          <Field label="JS expression (runs in the page)">
            <textarea
              className={inputClass}
              rows={3}
              value={f.expression ?? ''}
              onChange={(e) => {
                onChange({ expression: e.target.value });
              }}
              spellCheck={false}
            />
          </Field>
          <Field label="Timeout (ms, optional)">
            <input
              className={inputClass}
              type="number"
              min={1}
              max={120000}
              value={num(f.timeoutMs)}
              onChange={(e) => {
                onChange({ timeoutMs: setNum(e.target.value) });
              }}
              placeholder="default"
            />
          </Field>
        </div>
      );
    case 'screenshot':
      return (
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={f.fullPage ?? false}
            onChange={(e) => {
              onChange({ fullPage: e.target.checked });
            }}
          />
          Capture full page
        </label>
      );
  }
}

export function WorkflowsPage({
  client,
  identity,
}: {
  client: ApiClient;
  identity: IdentityInfo | null;
}): React.JSX.Element {
  const canManage = hasPermission(identity, 'automation:scripts:manage');
  const canRun = hasPermission(identity, 'automation:run');

  const [scripts, setScripts] = useState<AutomationScript[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [blocks, setBlocks] = useState<WorkflowBlock[]>([]);
  const [versions, setVersions] = useState<ScriptVersionNumber[]>([]);
  const [profiles, setProfiles] = useState<ProfileDetail[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRunDialog, setShowRunDialog] = useState(false);
  const [jobName, setJobName] = useState('');
  const [jobProfileId, setJobProfileId] = useState('');
  const [lastJob, setLastJob] = useState<AutomationJob | null>(null);
  const [lastRun, setLastRun] = useState<AutomationRun | null>(null);
  const [addType, setAddType] = useState<BlockType>('navigate');

  const refreshScripts = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([client.listScripts(), client.listProfiles()]);
      setScripts(s.scripts);
      setProfiles(p.profiles);
    } catch (e) {
      setError(messageOf(e));
    }
  }, [client]);

  useEffect(() => {
    void refreshScripts();
  }, [refreshScripts]);

  // Poll the latest run while it is active.
  useEffect(() => {
    if (!lastRun || TERMINAL_RUN_STATUSES.has(lastRun.status)) {
      return;
    }
    const timer = setInterval(() => {
      client
        .listRuns(lastRun.jobId)
        .then((r) => {
          const current = r.runs.find((x) => x.id === lastRun.id);
          if (current) {
            setLastRun(current);
          }
        })
        .catch(() => {
          /* keep the last known status */
        });
    }, 3000);
    return () => {
      clearInterval(timer);
    };
  }, [client, lastRun]);

  const selected = scripts.find((s) => s.id === selectedId) ?? null;
  const problems = validateBlocks(blocks);
  const problemsByIndex = new Map(
    problems.filter((p) => p.index >= 0).map((p) => [p.index, p.errors]),
  );
  const globalProblems = problems.filter((p) => p.index < 0).flatMap((p) => p.errors);
  const isValid = problems.length === 0 && name.trim().length > 0;

  function newWorkflow(): void {
    setSelectedId(null);
    setName('');
    setDescription('');
    setBlocks([createBlock('navigate')]);
    setVersions([]);
    setLastJob(null);
    setLastRun(null);
    setError(null);
  }

  async function openScript(id: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { script, versions: v } = await client.getScript(id);
      setSelectedId(script.id);
      setName(script.name);
      setDescription(script.description ?? '');
      setBlocks(stepsToBlocks(script.steps));
      setVersions(v);
      setLastJob(null);
      setLastRun(null);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function openVersion(version: number): Promise<void> {
    if (!selectedId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { script } = await client.getScript(selectedId, version);
      setName(script.name);
      setDescription(script.description ?? '');
      setBlocks(stepsToBlocks(script.steps));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  function updateBlock(id: string, patch: WorkflowBlockFields): void {
    setBlocks((prev) =>
      prev.map((b) => (b.id === id ? { ...b, fields: { ...b.fields, ...patch } } : b)),
    );
  }

  async function save(): Promise<void> {
    if (!isValid) {
      return;
    }
    const steps = blocksToSteps(blocks);
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    setBusy(true);
    setError(null);
    try {
      if (selectedId) {
        const { script } = await client.createScriptVersion(selectedId, {
          ...(trimmedDescription ? { description: trimmedDescription } : {}),
          steps,
        });
        setVersions((await client.getScript(selectedId)).versions);
        setBlocks(stepsToBlocks(script.steps));
      } else {
        const { script } = await client.createScript({
          name: trimmedName,
          ...(trimmedDescription ? { description: trimmedDescription } : {}),
          steps,
        });
        setSelectedId(script.id);
        await refreshScripts();
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function runAsJob(): Promise<void> {
    if (!selectedId || !jobProfileId) {
      setError('Pick a profile to run the job on.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { job, run } = await client.createJob({
        name: jobName.trim() || `${name.trim() || 'workflow'} run`,
        scriptId: selectedId,
        profileId: jobProfileId,
      });
      setLastJob(job);
      setLastRun(run);
      setShowRunDialog(false);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Workflows</h1>
        {canManage && (
          <Button variant="primary" onClick={newWorkflow}>
            New workflow
          </Button>
        )}
      </div>
      {error && (
        <ErrorBanner
          message={error}
          onDismiss={() => {
            setError(null);
          }}
        />
      )}

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <div className="rounded border border-zinc-800 p-3">
          <h2 className="mb-2 text-sm font-medium text-zinc-400">Scripts</h2>
          {scripts.length === 0 ? (
            <EmptyState message="No workflows yet. Create one to get started." />
          ) : (
            <ul className="space-y-1">
              {scripts.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => void openScript(s.id)}
                    className={`w-full rounded px-2 py-1.5 text-left text-sm hover:bg-zinc-900 ${
                      s.id === selectedId ? 'bg-zinc-900 text-white' : 'text-zinc-300'
                    }`}
                  >
                    <div className="font-medium">{s.name}</div>
                    <div className="text-xs text-zinc-500">
                      v{String(s.version)} · {String(s.steps.length)} steps
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded border border-zinc-800 p-4">
          {selectedId === null && blocks.length === 0 ? (
            <EmptyState message="Select a workflow on the left, or create a new one." />
          ) : (
            <>
              <div className="mb-4 grid gap-2 md:grid-cols-2">
                <Field label="Workflow name">
                  <input
                    className={inputClass}
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                    }}
                    maxLength={200}
                    disabled={!canManage}
                  />
                </Field>
                <Field label="Description (optional)">
                  <input
                    className={inputClass}
                    value={description}
                    onChange={(e) => {
                      setDescription(e.target.value);
                    }}
                    maxLength={2000}
                    disabled={!canManage}
                  />
                </Field>
              </div>

              {versions.length > 0 && (
                <div className="mb-4">
                  <Field label="Version history (loads that version into the editor)">
                    <select
                      className={inputClass}
                      value=""
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (v > 0) {
                          void openVersion(v);
                        }
                      }}
                      disabled={busy}
                    >
                      <option value="">Current: v{String(selected?.version ?? '?')}</option>
                      {versions.map((v) => (
                        <option key={v} value={v}>
                          v{String(v)}
                          {v === selected?.version ? ' (current)' : ' (load into editor)'}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              )}

              <h2 className="mb-2 text-sm font-medium text-zinc-400">
                Blocks ({String(blocks.length)})
              </h2>
              <ol className="space-y-2">
                {blocks.map((b, index) => {
                  const blockErrors = problemsByIndex.get(index) ?? [];
                  return (
                    <li key={b.id} className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <div>
                          <span className="mr-2 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-400">
                            {String(index + 1)}
                          </span>
                          <span className="text-sm font-medium">{BLOCK_LABELS[b.type]}</span>
                          <span className="ml-2 text-xs text-zinc-500">
                            {BLOCK_DESCRIPTIONS[b.type]}
                          </span>
                        </div>
                        {canManage && (
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              disabled={index === 0}
                              onClick={() => {
                                setBlocks((prev) => moveBlock(prev, index, -1));
                              }}
                              title="Move up"
                            >
                              ↑
                            </Button>
                            <Button
                              variant="ghost"
                              disabled={index === blocks.length - 1}
                              onClick={() => {
                                setBlocks((prev) => moveBlock(prev, index, 1));
                              }}
                              title="Move down"
                            >
                              ↓
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() => {
                                setBlocks((prev) => prev.filter((x) => x.id !== b.id));
                              }}
                              title="Remove block"
                            >
                              ✕
                            </Button>
                          </div>
                        )}
                      </div>
                      {b.raw !== undefined ? (
                        <pre className="overflow-x-auto rounded bg-zinc-950 p-2 text-xs text-zinc-400">
                          {JSON.stringify(b.raw, null, 2)}
                        </pre>
                      ) : (
                        <BlockFieldsEditor
                          block={b}
                          onChange={(patch) => {
                            updateBlock(b.id, patch);
                          }}
                        />
                      )}
                      {blockErrors.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {blockErrors.map((msg) => (
                            <li key={msg} className="text-xs text-red-400">
                              {msg}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ol>

              {globalProblems.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {globalProblems.map((msg) => (
                    <li key={msg} className="text-xs text-red-400">
                      {msg}
                    </li>
                  ))}
                </ul>
              )}

              {canManage && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <select
                    className={inputClass}
                    value={addType}
                    onChange={(e) => {
                      setAddType(e.target.value as BlockType);
                    }}
                    aria-label="Block type to add"
                  >
                    {BLOCK_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {BLOCK_LABELS[t]}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setBlocks((prev) => [...prev, createBlock(addType)]);
                    }}
                  >
                    Add block
                  </Button>
                </div>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                {canManage && (
                  <Button variant="primary" disabled={busy || !isValid} onClick={() => void save()}>
                    {selectedId ? 'Save as new version' : 'Save workflow'}
                  </Button>
                )}
                {canRun && selectedId && (
                  <Button
                    variant="ghost"
                    disabled={busy || blocks.length === 0}
                    onClick={() => {
                      setJobName(`${name.trim() || 'workflow'} run`);
                      setShowRunDialog(true);
                    }}
                  >
                    Run as job…
                  </Button>
                )}
              </div>

              {lastJob && lastRun && (
                <div className="mt-4 rounded border border-zinc-800 p-3 text-sm">
                  <div className="font-medium">Job: {lastJob.name}</div>
                  <div className="text-xs text-zinc-400">
                    Run {lastRun.id.slice(0, 8)} · status: {lastRun.status}
                    {lastRun.error ? ` · ${lastRun.error}` : ''}
                    {lastRun.artifactCount > 0
                      ? ` · ${String(lastRun.artifactCount)} artifact(s)`
                      : ''}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {showRunDialog && (
        <Modal
          title="Run workflow as job"
          onClose={() => {
            setShowRunDialog(false);
          }}
        >
          <div className="space-y-4">
            <Field label="Job name">
              <input
                className={inputClass}
                value={jobName}
                onChange={(e) => {
                  setJobName(e.target.value);
                }}
                maxLength={200}
              />
            </Field>
            <Field label="Profile (must be running)">
              <select
                className={inputClass}
                value={jobProfileId}
                onChange={(e) => {
                  setJobProfileId(e.target.value);
                }}
                required
              >
                <option value="">Select a profile…</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.state})
                  </option>
                ))}
              </select>
            </Field>
            <p className="text-xs text-zinc-500">
              Uses the saved script version (v{String(selected?.version ?? '?')}). Save your changes
              first if you edited the blocks.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setShowRunDialog(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy || !jobProfileId}
                onClick={() => void runAsJob()}
              >
                Launch job
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
