import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, Field, Modal, Select, Spinner, Tag } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { PERSON_ROLE_LABELS } from '../../lib/constants';
import type { MergePreview, Person } from '../../api/types';

export function MergeDialog({
  fid,
  source,
  people,
  open,
  onClose,
  onMerged,
}: {
  fid: string;
  source: Person;
  people: Person[];
  open: boolean;
  onClose: () => void;
  onMerged?: (targetId: string, mergeId: string) => void;
}) {
  const { push } = useToast();
  const [targetId, setTargetId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(() => people.filter((p) => p.id !== source.id && !p.mergedIntoId), [people, source.id]);

  const preview = useQuery({
    queryKey: ['merge-preview', fid, source.id, targetId],
    queryFn: () =>
      api
        .post<{ preview: MergePreview }>(`/families/${fid}/people/${source.id}/merge/preview`, { targetPersonId: targetId })
        .then((r) => r.preview),
    enabled: open && Boolean(targetId),
  });

  const merge = useMutation({
    mutationFn: async () => {
      const { person } = await api.post<{ person: { id: string; mergeHistory: { id: string }[] } }>(
        `/families/${fid}/people/${source.id}/merge`,
        { targetPersonId: targetId },
      );
      return person;
    },
    onSuccess: async (person) => {
      const mergeId = person.mergeHistory[0]?.id;
      push('人物已合并，可在人物页撤销', 'success');
      setTargetId('');
      onMerged?.(person.id, mergeId ?? '');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : '合并失败'),
  });

  const reset = () => {
    setTargetId('');
    setError(null);
    onClose();
  };

  return (
    <Modal
      open={open}
      title={`将「${source.name}」合并到…`}
      onClose={reset}
      footer={
        <>
          <Button onClick={reset}>取消</Button>
          <Button
            variant="danger"
            loading={merge.isPending}
            disabled={!targetId || preview.isLoading}
            onClick={() => {
              setError(null);
              merge.mutate();
            }}
          >
            确认合并
          </Button>
        </>
      }
    >
      <Field label="合并到哪位人物" hint="合并后「称呼」与「别名」会保留到对方档案，当前人物不再出现在列表里">
        <Select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
          <option value="">请选择…</option>
          {candidates.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.relation ? `（${p.relation}）` : ''}
            </option>
          ))}
        </Select>
      </Field>

      {targetId && preview.isLoading ? <Spinner label="正在核对受影响的条目…" /> : null}

      {targetId && preview.error ? (
        <p className="field__error" role="alert">
          {preview.error instanceof ApiError ? preview.error.message : '预览失败'}
        </p>
      ) : null}

      {targetId && preview.data ? (
        <div className="stack" style={{ gap: 'var(--space-3)' }}>
          <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Tag tone="success">{preview.data.movedCount} 条关联将转挂</Tag>
            <Tag tone={preview.data.conflictCount > 0 ? 'warn' : 'muted'}>
              {preview.data.conflictCount} 条冲突将去重
            </Tag>
          </div>

          {preview.data.movable.length > 0 ? (
            <PreviewList
              title="转挂到目标人物的条目"
              rows={preview.data.movable}
              tone="muted"
              note="这些条目只关联了当前人物，合并后自动改挂到目标人物名下。"
            />
          ) : null}

          {preview.data.conflicts.length > 0 ? (
            <PreviewList
              title="冲突条目（同一条目、同一角色两边都在）"
              rows={preview.data.conflicts}
              tone="warn"
              note="合并后保留目标人物名下的关联，当前人物的重复关联会被移除；撤销合并可恢复。"
            />
          ) : null}

          {preview.data.totalCount === 0 ? (
            <p className="muted">当前人物没有关联任何条目，合并只会整理档案本身。</p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

function PreviewList({
  title,
  rows,
  tone,
  note,
}: {
  title: string;
  rows: MergePreview['movable'];
  tone: 'muted' | 'warn';
  note: string;
}) {
  return (
    <section>
      <h3 style={{ marginBottom: 4 }}>{title}</h3>
      <p className="muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 'var(--space-2)' }}>
        {note}
      </p>
      <ul className="merge-preview-list" style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
        {rows.map((r) => (
          <li
            key={r.linkId}
            className="card"
            style={{ padding: 'var(--space-2) var(--space-3)', marginBottom: 'var(--space-2)' }}
          >
            <div className="row" style={{ gap: 'var(--space-2)', justifyContent: 'space-between' }}>
              <span>{r.item.title}</span>
              <Tag tone={tone}>{PERSON_ROLE_LABELS[r.role]}</Tag>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
