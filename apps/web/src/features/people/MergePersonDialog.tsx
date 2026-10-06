import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, Modal, Spinner, Tag } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { CATEGORY_LABELS, PERSON_ROLE_LABELS } from '../../lib/constants';
import type { Person, PersonMergePreview } from '../../api/types';

/**
 * 合并人物对话框：
 * 1. 选目标人物 → 2. 拉合并预览（受影响条目 + 冲突）→ 3. 确认执行。
 * 冲突 = 同一条目、同一种关联方式两边都有，合并时会折叠成一条。
 */
export function MergePersonDialog({
  fid,
  source,
  open,
  onClose,
  onMerged,
}: {
  fid: string;
  source: Person;
  open: boolean;
  onClose: () => void;
  onMerged?: (targetId: string) => void;
}) {
  const { push } = useToast();
  const queryClient = useQueryClient();
  const [targetId, setTargetId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const people = useQuery({
    queryKey: ['people', fid],
    queryFn: () => api.get<{ people: Person[] }>(`/families/${fid}/people`),
    enabled: open,
  });

  const targets = useMemo(
    () => (people.data?.people ?? []).filter((p) => p.id !== source.id),
    [people.data, source.id],
  );

  const preview = useQuery({
    queryKey: ['merge-preview', fid, source.id, targetId],
    queryFn: () =>
      api.get<{ preview: PersonMergePreview }>(
        `/families/${fid}/people/${source.id}/merge-preview?targetPersonId=${targetId}`,
      ),
    enabled: open && Boolean(targetId),
  });

  const merge = useMutation({
    mutationFn: () => api.post(`/families/${fid}/people/${source.id}/merge`, { targetPersonId: targetId }),
    onSuccess: async () => {
      push(`已将「${source.name}」合并到所选人物`, 'success');
      await queryClient.invalidateQueries({ queryKey: ['people', fid] });
      await queryClient.invalidateQueries({ queryKey: ['person', fid] });
      onMerged?.(targetId);
      handleClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : '合并失败'),
  });

  function handleClose() {
    setTargetId('');
    setError(null);
    onClose();
  }

  return (
    <Modal
      open={open}
      title={`合并人物：${source.name}`}
      onClose={handleClose}
      footer={
        <>
          <Button onClick={handleClose}>取消</Button>
          <Button
            variant="primary"
            disabled={!targetId || preview.isLoading}
            loading={merge.isPending}
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
      <p className="muted" style={{ marginTop: 0 }}>
        合并后「{source.name}」将被标记为已并入，其关联条目转移到目标人物；合并全程留痕，可随时撤销。
      </p>

      <label className="field">
        <span className="field__label">合并到哪位人物</span>
        <select
          className="input input--select"
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
        >
          <option value="">请选择…</option>
          {targets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.relation ? `（${p.relation}）` : ''} · 关联 {p.itemCount} 件
            </option>
          ))}
        </select>
      </label>

      {targetId ? (
        preview.isLoading ? (
          <Spinner label="正在统计受影响条目…" />
        ) : preview.error ? (
          <p className="field__error" role="alert">
            {preview.error instanceof ApiError ? preview.error.message : '预览失败'}
          </p>
        ) : preview.data ? (
          <PreviewBody data={preview.data.preview} />
        ) : null
      ) : null}

      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

function PreviewBody({ data }: { data: PersonMergePreview }) {
  const { moved, conflicts, hiddenCount } = data;
  return (
    <div style={{ marginTop: 'var(--space-3)' }}>
      <div className="row" style={{ gap: 8, marginBottom: 'var(--space-3)' }}>
        <Tag tone="success">{moved.length} 条关联将转移</Tag>
        <Tag tone={conflicts.length ? 'warn' : 'default'}>{conflicts.length} 条重复将折叠</Tag>
      </div>

      {conflicts.length > 0 ? (
        <section style={{ marginBottom: 'var(--space-3)' }}>
          <h3 style={{ fontSize: 14, marginBottom: 6 }}>需要注意的重复条目</h3>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            同一条目下同一种关联方式两边都有，合并后保留目标人物的一条，两边的关系说明会并列保留。
          </p>
          <ul className="merge-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {conflicts.slice(0, 8).map((e) => (
              <li key={e.linkId} className="merge-list__item">
                <strong>{e.itemTitle}</strong>
                <span className="muted"> · {e.category ? CATEGORY_LABELS[e.category] : ''} · {PERSON_ROLE_LABELS[e.role]}</span>
                {e.sourceNote ? <div className="muted" style={{ fontSize: 12 }}>来源人物备注：{e.sourceNote}</div> : null}
                {e.targetNote ? <div className="muted" style={{ fontSize: 12 }}>目标人物备注：{e.targetNote}</div> : null}
              </li>
            ))}
            {conflicts.length > 8 ? <li className="muted">… 另有 {conflicts.length - 8} 条</li> : null}
          </ul>
        </section>
      ) : null}

      {moved.length > 0 ? (
        <section>
          <h3 style={{ fontSize: 14, marginBottom: 6 }}>将转移到目标人物的条目</h3>
          <ul className="merge-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {moved.slice(0, 8).map((e) => (
              <li key={e.linkId} className="merge-list__item">
                <strong>{e.itemTitle}</strong>
                <span className="muted"> · {PERSON_ROLE_LABELS[e.role]}</span>
                {e.sourceNote ? <div className="muted" style={{ fontSize: 12 }}>{e.sourceNote}</div> : null}
              </li>
            ))}
            {moved.length > 8 ? <li className="muted">… 另有 {moved.length - 8} 条</li> : null}
          </ul>
        </section>
      ) : null}

      {moved.length === 0 && conflicts.length === 0 ? (
        <p className="muted">来源人物当前没有关联条目，仅档案会被标记为已并入。</p>
      ) : null}

      {hiddenCount > 0 ? (
        <p className="muted" style={{ fontSize: 12, marginTop: 'var(--space-3)' }}>
          另有 {hiddenCount} 条关联因你的可见范围无法在此预览，合并时仍会一并处理。
        </p>
      ) : null}
    </div>
  );
}
