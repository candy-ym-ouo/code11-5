import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, EmptyState, Spinner, Tag } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { ItemCard } from '../items/ItemCard';
import { PERSON_ROLE_LABELS } from '../../lib/constants';
import { useFamily } from '../families/useFamily';
import { PersonFormModal } from './PersonFormModal';
import { MergePersonDialog } from './MergePersonDialog';
import type { MergedPersonConflict, Person, PersonDetail, PersonMergeRecord } from '../../api/types';

export function PersonDetailPage() {
  const { fid, personId } = useParams<{ fid: string; personId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const { data: familyData } = useFamily(fid);
  const [editOpen, setEditOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);

  const query = useQuery({
    queryKey: ['person', fid, personId],
    queryFn: () => api.get<{ person: PersonDetail }>(`/families/${fid}/people/${personId}`),
    enabled: Boolean(fid && personId),
    retry: false,
  });

  // 已被合并的人物：后端返回 409 + 去向信息
  const mergedConflict: MergedPersonConflict | null =
    query.error instanceof ApiError && query.error.status === 409 && (query.error.details as MergedPersonConflict | null)?.merged
      ? (query.error.details as MergedPersonConflict)
      : null;

  const canWrite = familyData && ['owner', 'admin', 'editor'].includes(familyData.myRole);
  const canDelete = familyData && ['owner', 'admin'].includes(familyData.myRole);

  const remove = useMutation({
    mutationFn: () => api.del(`/families/${fid}/people/${personId}`),
    onSuccess: async () => {
      push('人物已删除', 'success');
      await queryClient.invalidateQueries({ queryKey: ['people', fid] });
      navigate(`/f/${fid}/people`);
    },
    onError: (err) => push(err instanceof ApiError ? err.message : '删除失败', 'error'),
  });

  if (query.isLoading) return <Spinner />;

  if (mergedConflict) {
    return <MergedPersonView fid={fid!} conflict={mergedConflict} canDelete={Boolean(canDelete)} onChanged={() => navigate(`/f/${fid}/people`)} />;
  }

  const person = query.data?.person;
  if (!person) {
    return (
      <EmptyState
        title="找不到这个人物"
        action={
          <Button onClick={() => navigate(`/f/${fid}/people`)}>返回人物列表</Button>
        }
      />
    );
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{person.name}</h1>
          <p className="page-head__sub">
            {person.relation ? `${person.relation} · ` : ''}
            {person.birthYear ? `${person.birthYear}${person.deathYear ? `–${person.deathYear}` : ''}` : '年份未记录'}
          </p>
          {person.aliases.length > 0 ? (
            <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              {person.aliases.map((a) => (
                <Tag key={a} tone="muted">别名：{a}</Tag>
              ))}
            </div>
          ) : null}
        </div>
        <div className="row" style={{ gap: 8 }}>
          {canWrite ? <Button onClick={() => setEditOpen(true)}>编辑档案</Button> : null}
          {canDelete ? <Button onClick={() => setMergeOpen(true)}>合并到…</Button> : null}
          {canDelete ? (
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => {
                if (window.confirm(`确定删除人物「${person.name}」？有关联条目的人物需要先合并。`)) {
                  remove.mutate();
                }
              }}
            >
              删除
            </Button>
          ) : null}
          <Button onClick={() => navigate(-1)}>返回</Button>
        </div>
      </div>

      {person.relationNote ? (
        <section className="card">
          <h2 style={{ marginBottom: 'var(--space-2)' }}>关系说明</h2>
          <p style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{person.relationNote}</p>
        </section>
      ) : null}

      {person.bio ? (
        <section className="card">
          <h2 style={{ marginBottom: 'var(--space-2)' }}>小传</h2>
          <p style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{person.bio}</p>
        </section>
      ) : null}

      {person.merges.length > 0 ? <MergeHistory fid={fid!} merges={person.merges} canDelete={Boolean(canDelete)} onChanged={() => void queryClient.invalidateQueries({ queryKey: ['person', fid] })} /> : null}

      <section>
        <h2 style={{ marginBottom: 'var(--space-3)' }}>相关的物品（{person.items.length}）</h2>
        {person.items.length === 0 ? (
          <EmptyState
            icon="📦"
            title="还没有关联的物品"
            description="在记录物品时选择这位人物，就会在这里出现。"
          />
        ) : (
          <div className="grid-cards">
            {person.items.map((item) => (
              <div key={`${item.id}-${item.role}`}>
                <ItemCard item={item} fid={fid!} />
                <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                  <Tag>{PERSON_ROLE_LABELS[item.role]}</Tag>
                  {item.note ? <small className="muted">{item.note}</small> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {editOpen ? (
        <PersonFormModal
          fid={fid!}
          person={person}
          open={editOpen}
          onClose={() => setEditOpen(false)}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: ['person', fid, personId] })}
        />
      ) : null}
      {mergeOpen ? (
        <MergePersonDialog
          fid={fid!}
          source={person}
          open={mergeOpen}
          onClose={() => setMergeOpen(false)}
          onMerged={(targetId) => navigate(`/f/${fid}/people/${targetId}`)}
        />
      ) : null}
    </div>
  );
}

/** 合并历史时间线：记录「谁并入了谁」，未撤销的最近一条提供撤销按钮。 */
export function MergeHistory({
  fid,
  merges,
  canDelete,
  onChanged,
}: {
  fid: string;
  merges: PersonMergeRecord[];
  canDelete: boolean;
  onChanged: () => void;
}) {
  const { push } = useToast();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function undo(id: string) {
    if (!window.confirm('撤销这次合并？来源人物档案与其关联条目将按合并时的记录还原。')) return;
    setBusyId(id);
    try {
      const res = await api.post<{ restoredId: string }>(`/families/${fid}/people/merges/${id}/undo`, {});
      push('已撤销合并，人物档案已还原', 'success');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['people', fid] }),
        queryClient.invalidateQueries({ queryKey: ['person', fid] }),
      ]);
      onChanged();
      return res.restoredId;
    } catch (err) {
      push(err instanceof ApiError ? err.message : '撤销失败', 'error');
    } finally {
      setBusyId(null);
    }
  }

  // 可撤销的是「最近一次、且未撤销」的合并（后端同样会强校验链式顺序）
  const latestActive = merges.find((m) => !m.undone)?.id ?? null;

  return (
    <section className="card">
      <h2 style={{ marginBottom: 'var(--space-3)' }}>合并记录</h2>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} className="merge-history">
        {merges.map((m) => (
          <li key={m.id} className="merge-history__item" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
            <div>
              <span>
                「{m.sourceName}」并入「{m.targetName}」
              </span>
              {m.undone ? <Tag tone="muted">已撤销 · {new Date(m.undoneAt!).toLocaleString('zh-CN')}</Tag> : <Tag tone="warn">生效中</Tag>}
              <div className="muted" style={{ fontSize: 12 }}>{new Date(m.createdAt).toLocaleString('zh-CN')}</div>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <Link className="btn btn--ghost btn--sm" to={`/f/${fid}/people/${m.sourceId}`}>
                查看来源
              </Link>
              {canDelete && !m.undone && m.id === latestActive ? (
                <Button size="sm" variant="danger" loading={busyId === m.id} onClick={() => void undo(m.id)}>
                  撤销合并
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 已合并人物页：明确去向、可追溯历史、管理员可撤销还原。 */
function MergedPersonView({
  fid,
  conflict,
  canDelete,
  onChanged,
}: {
  fid: string;
  conflict: MergedPersonConflict;
  canDelete: boolean;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const { push } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const undoId = conflict.merges.find((m) => !m.undone)?.id;

  async function undo() {
    if (!undoId) return;
    if (!window.confirm(`撤销合并，还原「${conflict.person.name}」？`)) return;
    setBusy(true);
    try {
      const res = await api.post<{ restoredId: string }>(`/families/${fid}/people/merges/${undoId}/undo`, {});
      push('已撤销合并，人物档案已还原', 'success');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['people', fid] }),
        queryClient.invalidateQueries({ queryKey: ['person', fid, res.restoredId] }),
      ]);
      navigate(`/f/${fid}/people/${res.restoredId}`);
    } catch (err) {
      push(err instanceof ApiError ? err.message : '撤销失败', 'error');
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{conflict.person.name}</h1>
          <p className="page-head__sub">
            <Tag tone="warn">此人物已合并</Tag>
          </p>
        </div>
        <Button onClick={() => navigate(`/f/${fid}/people`)}>返回人物列表</Button>
      </div>

      <section className="card">
        {conflict.person.aliases.length > 0 ? (
          <p className="muted" style={{ marginTop: 0 }}>别名：{conflict.person.aliases.join('、')}</p>
        ) : null}
        {conflict.mergedInto ? (
          <p style={{ marginBottom: canDelete ? 'var(--space-3)' : 0 }}>
            该人物的档案与关联条目已并入{' '}
            <Link to={`/f/${fid}/people/${conflict.mergedInto.id}`}>
              <strong>{conflict.mergedInto.name}</strong>
            </Link>
            。
          </p>
        ) : (
          <p>该人物曾被合并，目标档案当前不可用。</p>
        )}
        {canDelete && undoId ? (
          <Button variant="danger" loading={busy} onClick={() => void undo()}>
            撤销合并并还原
          </Button>
        ) : null}
      </section>

      {conflict.merges.length > 0 ? <MergeHistory fid={fid} merges={conflict.merges} canDelete={canDelete} onChanged={onChanged} /> : null}
    </div>
  );
}
